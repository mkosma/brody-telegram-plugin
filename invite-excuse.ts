/**
 * `/invite` and `/excuse`: Monty opens a topic to a bot, or closes it, from
 * the topic itself.
 *
 * SPEC-bridge-names-invite-excuse-2026-11-09 item 2.
 *
 * BEFORE THE GATE. Privacy mode is off for every fleet bot, so each bridge
 * receives the command however the group is gated, and each acts only when
 * the command names its own agent (`@grady`) or its own bot
 * (`@MK_GradyBot`, or Telegram's `/invite@MK_GradyBot`). The @ is optional:
 * `/excuse Grady` names Grady as `/excuse @grady` does. Every bare word after
 * the verb is read as a name, and a word that is no bridge's name moves
 * nobody. A command with no name means nothing, because which bot was meant
 * is ambiguous.
 *
 * AUTHORITY. Only a sender in this bridge's top-level `allowFrom` (today,
 * Monty) may run it; for anyone else, and for any bot, nothing happens and
 * nothing is said. An /invite into a group this bridge has no entry for
 * creates one, mention-only, with that one thread open: Monty's /invite is
 * his permission to deliver that group (Open question 2 of the spec).
 *
 * THE ANSWER comes from the bridge, not from the agent's turn, so it arrives
 * when the session is busy. It is one line from the agent's own list
 * (phrases.ts). The agent is told as well, by a channel event
 * with meta.command and meta.thread_key.
 *
 * SPEC-bridge-who-and-all-2026-11-12 adds two things.
 *
 * `/who`. Every bridge in the group sees it, so exactly one answers: the
 * bridge whose agent is WHO_ANSWERER. It runs Vera's `who-hears` for the
 * command's thread, bounded at WHO_TIMEOUT_MS, and replies with its output,
 * or with one failure line. No session hop: the answer arrives while the
 * session is busy.
 *
 * `all`. The names list may be `all` or `all but <name> ...`. Every bridge
 * not named after `but` applies its own change and says nothing; the
 * WHO_ANSWERER bridge alone posts one summary, built from the parse, even
 * when `but` excludes it. `all` beside an explicit name is refused, by the
 * answerer alone, and nothing is applied.
 */

import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { threadKey, type GroupPolicy } from './group-gate.ts'

export type Verb = 'invite' | 'excuse'

export const STATIC_ANSWER = "I can't change my settings in this mode."

/** The one agent whose bridge answers `/who` and confirms an `all` command. */
export const WHO_ANSWERER = 'Vera'
export const WHO_HEARS_BIN = join(homedir(), 'dev', 'agents', 'agents', 'Vera', 'bin', 'who-hears')
export const WHO_TIMEOUT_MS = 15000
export const MIXED_ANSWER = 'Use "all" or names, not both. Example: /excuse all but maya'
const RC_TIMEOUT = 124
const TELEGRAM_TEXT_MAX = 4096

export type ParsedCommand = {
  verb: Verb | 'who'
  names: string[]
  /** The list was `all` or `all but <names>`; `but` holds the names excluded. */
  all?: { but: string[] }
  /** `all` beside an explicit name, or a `but` with nothing after it. */
  mixed?: true
}

/**
 * `/invite @a b`, `/excuse@MK_ABot`: the verb and the names it carries,
 * lowercased, without the @. The @ is optional. The text after the verb is
 * split on whitespace and commas, and a token is a name only when the whole
 * of it, less trailing punctuation, is `@?[A-Za-z0-9_]+`: `x@grady.com`
 * names nobody. `/who` carries no names. A list holding the word `all` is
 * `all`, `all but <names>`, or mixed.
 */
export function parseGroupCommand(text: string): ParsedCommand | undefined {
  const m = /^\/(invite|excuse|who)(?:@([A-Za-z0-9_]+))?(?=\s|$)([\s\S]*)$/i.exec(text.trim())
  if (!m) return undefined
  if (m[1].toLowerCase() === 'who') return { verb: 'who', names: [] }
  const names = m[3]
    .split(/[\s,]+/)
    .map(t => t.replace(/[.,!?;:]+$/, ''))
    .filter(t => /^@?[A-Za-z0-9_]+$/.test(t))
    .map(t => t.replace(/^@/, '').toLowerCase())
  if (m[2]) names.unshift(m[2].toLowerCase())
  const verb = m[1].toLowerCase() as Verb
  if (!names.includes('all')) return { verb, names }
  if (names.length === 1) return { verb, names, all: { but: [] } }
  const but = names.slice(2)
  if (names[0] === 'all' && names[1] === 'but' && but.length > 0 && !but.includes('all')) return { verb, names, all: { but } }
  return { verb, names, mixed: true }
}

/** The answerer's one line for an `all` command, from the parse alone. */
export function allSummary(verb: Verb, but: string[]): string {
  return `${verb === 'invite' ? 'Invited' : 'Excused'}: all${but.length > 0 ? ` but ${but.join(', ')}` : ''}.`
}

export type CommandAccess = { allowFrom: string[]; groups: Record<string, GroupPolicy> }

/**
 * Apply the verb to one thread's entry. Returns false, having changed
 * nothing, when the entry is already in that state. "Already" is the thread's
 * own entry, not the effective setting, so an invite survives a later change
 * to the group's default. An /excuse never creates a group: no entry means
 * nothing is delivered from there already.
 */
export function applyGroupCommand(access: CommandAccess, chat_id: string, key: string, verb: Verb): boolean {
  const group = access.groups[chat_id]
  if (verb === 'invite') {
    if (!group) {
      access.groups[chat_id] = { requireMention: true, allowFrom: [], threads: { [key]: { requireMention: false } } }
      return true
    }
    if (group.threads?.[key]?.requireMention === false) return false
    group.threads = { ...(group.threads ?? {}), [key]: { ...(group.threads?.[key] ?? {}), requireMention: false } }
    return true
  }
  if (!group) return false
  if (group.threads?.[key]?.requireMention === true) return false
  group.threads = { ...(group.threads ?? {}), [key]: { ...(group.threads?.[key] ?? {}), requireMention: true } }
  return true
}

export type CommandMessage = {
  chat_id: string
  chat_type?: string
  from?: { id: number; is_bot?: boolean }
  /** The message's text; a caption is never a command. */
  text?: string
  message_thread_id?: number
}

export type CommandPlan =
  /** Not an /invite, /excuse or /who in a group: the ordinary gate decides. */
  | { kind: 'none' }
  /** A command this bridge does nothing about: not its name, not an allowFrom sender, or no name at all. */
  | { kind: 'ignore' }
  /**
   * `quiet`: an `all` command, so this bridge applies without its own answer.
   * `summary`: this bridge is the answerer and posts the one confirmation.
   */
  | { kind: 'act'; verb: Verb; chat_id: string; thread_id?: number; key: string; quiet?: true; summary?: string }
  /** The answerer's one line with nothing applied here: a refusal, or the summary of an `all` that excludes it. */
  | { kind: 'say'; chat_id: string; thread_id?: number; text: string }
  /** `/who`, on the answerer's bridge only. */
  | { kind: 'who'; chat_id: string; thread_id?: number; key: string }

export type CommandDeps<A extends CommandAccess = CommandAccess> = {
  /** This bridge's agent, as the claude() wrapper verified it, or '<Agent>'. */
  agent: string
  botUsername: () => string
  /** TELEGRAM_ACCESS_MODE=static: saveAccess is a no-op, so nothing may claim a change. */
  isStatic: boolean
  loadAccess: () => A
  saveAccess: (a: A) => void
  /** The answer line for a verb: one of the agent's own phrases (phrases.ts). */
  phrase: (verb: Verb) => string
  /** Post the bridge's answer into the thread (and log it). */
  answer: (chat_id: string, text: string, thread_id?: number) => Promise<void>
  /** Deliver the command into the session as a channel event. */
  notify: (verb: Verb, key: string) => void
  stderr?: (line: string) => void
}

/** Synchronous, so the post log can record the decision with the inbound line. */
export function planGroupCommand<A extends CommandAccess>(deps: CommandDeps<A>, msg: CommandMessage): CommandPlan {
  if (msg.chat_type !== 'group' && msg.chat_type !== 'supergroup') return { kind: 'none' }
  const cmd = msg.text != null ? parseGroupCommand(msg.text) : undefined
  if (!cmd) return { kind: 'none' }
  if (!msg.from || msg.from.is_bot) return { kind: 'ignore' }
  if (!deps.loadAccess().allowFrom.includes(String(msg.from.id))) return { kind: 'ignore' }
  const mine = new Set<string>()
  if (deps.agent && deps.agent !== '<Agent>') mine.add(deps.agent.toLowerCase())
  const bot = deps.botUsername()
  if (bot) mine.add(bot.toLowerCase())
  const at = { chat_id: msg.chat_id, thread_id: msg.message_thread_id, key: threadKey(msg.message_thread_id) }
  const answerer = deps.agent === WHO_ANSWERER
  if (cmd.verb === 'who') return answerer ? { kind: 'who', ...at } : { kind: 'ignore' }
  if (cmd.mixed) return answerer ? { kind: 'say', chat_id: at.chat_id, thread_id: at.thread_id, text: MIXED_ANSWER } : { kind: 'ignore' }
  if (cmd.all) {
    const summary = answerer ? allSummary(cmd.verb, cmd.all.but) : undefined
    if (cmd.all.but.some(n => mine.has(n))) return summary ? { kind: 'say', chat_id: at.chat_id, thread_id: at.thread_id, text: summary } : { kind: 'ignore' }
    return { kind: 'act', verb: cmd.verb, ...at, quiet: true, ...(summary ? { summary } : {}) }
  }
  if (!cmd.names.some(n => mine.has(n))) return { kind: 'ignore' }
  return { kind: 'act', verb: cmd.verb, ...at }
}

export type CommandResult = 'changed' | 'unchanged' | 'static' | 'failed'

export async function runGroupCommand<A extends CommandAccess>(deps: CommandDeps<A>, plan: Extract<CommandPlan, { kind: 'act' }>): Promise<CommandResult> {
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const say = async (text: string) => {
    if (plan.quiet) return
    try {
      await deps.answer(plan.chat_id, text, plan.thread_id)
    } catch (err) {
      stderr(`telegram channel: /${plan.verb} answer failed: ${err}\n`)
    }
  }
  if (deps.isStatic) {
    await say(STATIC_ANSWER)
    return 'static'
  }
  const access = deps.loadAccess()
  const changed = applyGroupCommand(access, plan.chat_id, plan.key, plan.verb)
  if (changed) {
    try {
      deps.saveAccess(access)
    } catch (err) {
      // Unsaved is unchanged: say nothing that would claim otherwise.
      stderr(`telegram channel: /${plan.verb} not applied, access.json write failed: ${err}\n`)
      return 'failed'
    }
  }
  await say(deps.phrase(plan.verb))
  if (plan.summary) {
    try {
      await deps.answer(plan.chat_id, plan.summary, plan.thread_id)
    } catch (err) {
      stderr(`telegram channel: /${plan.verb} all summary failed: ${err}\n`)
    }
  }
  try {
    deps.notify(plan.verb, plan.key)
  } catch (err) {
    stderr(`telegram channel: /${plan.verb} not delivered to the session: ${err}\n`)
  }
  return changed ? 'changed' : 'unchanged'
}

/** Post the answerer's one line. Never rejects. */
export async function sayGroupCommand(deps: Pick<CommandDeps, 'answer' | 'stderr'>, plan: Extract<CommandPlan, { kind: 'say' }>): Promise<void> {
  try {
    await deps.answer(plan.chat_id, plan.text, plan.thread_id)
  } catch (err) {
    (deps.stderr ?? ((l: string) => { process.stderr.write(l) }))(`telegram channel: command answer failed: ${err}\n`)
  }
}

export type OutputRunner = (argv: string[], timeoutMs: number) => Promise<{ rc: number; stdout: string; stderr: string }>

/** Run argv and keep its stdout. Resolves, never rejects: 127 when it cannot start, 124 when killed at the bound. */
export const spawnOutput: OutputRunner = (argv, timeoutMs) =>
  new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (rc: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ rc, stdout, stderr }) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ rc: 127, stdout, stderr: String(e) })
      return
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(RC_TIMEOUT) }, timeoutMs)
    child.stdout?.on('data', d => { if (stdout.length < 16384) stdout += String(d) })
    child.stderr?.on('data', d => { if (stderr.length < 4096) stderr += String(d) })
    child.on('error', e => { stderr += String(e); finish(127) })
    child.on('close', code => finish(code ?? 1))
  })

export type WhoDeps = {
  run: OutputRunner
  answer: CommandDeps['answer']
  stderr?: (line: string) => void
  bin?: string
  timeoutMs?: number
}

/** The one line for a `who-hears` that did not answer. */
export function whoFailure(rc: number, stderr: string): string {
  const first = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0)
  return `/who failed: ${rc === RC_TIMEOUT ? 'timed out' : (first ?? `exited ${rc}`).slice(0, 200)}`
}

/**
 * Answer `/who`: `who-hears <thread key> --chat <chat_id>`, bounded, and its
 * stdout posted into the command's thread. Resolves 'answered' or 'failed',
 * never rejects.
 */
export async function runWho(deps: WhoDeps, plan: Extract<CommandPlan, { kind: 'who' }>): Promise<'answered' | 'failed'> {
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const r = await deps.run([deps.bin ?? WHO_HEARS_BIN, plan.key, '--chat', plan.chat_id], deps.timeoutMs ?? WHO_TIMEOUT_MS)
  const out = r.stdout.trim()
  const ok = r.rc === 0 && out.length > 0
  if (!ok) stderr(`telegram channel: who-hears failed: rc=${r.rc} ${r.stderr}\n`)
  const text = ok ? out.slice(0, TELEGRAM_TEXT_MAX) : whoFailure(r.rc, r.rc === 0 ? 'no output' : r.stderr)
  try {
    await deps.answer(plan.chat_id, text, plan.thread_id)
  } catch (err) {
    stderr(`telegram channel: /who answer failed: ${err}\n`)
  }
  return ok ? 'answered' : 'failed'
}
