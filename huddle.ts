/**
 * The huddle: `/done`, `/active`, `/next`, `/blockers`, `/status`, and
 * Monty's one-line answer to a numbered blocker.
 *
 * Grady's DESIGN-huddle-2026-11-26 (approved by Monty, FLEET 40 msg 3295).
 *
 * BEFORE THE GATE, like `/who`. Every bridge in the group sees the command,
 * so exactly one answers: the bridge whose agent is WHO_ANSWERER. It runs
 * `huddle <section> <agents...>` (monty-ops shell/bin/huddle), bounded at
 * HUDDLE_TIMEOUT_MS, and posts its output, which is Telegram MarkdownV2, in
 * the command's thread. No session hop. Every other bridge drops the command;
 * it is never delivered as chat.
 *
 * WHO IS ASKED. The words after the command are agent names, or `fleet`,
 * `everyone` or `all`; `huddle` reads them and refuses a name it does not
 * know. With no words it is the agents in this topic: the set `/who`
 * resolves, read by running the same `who-hears` `/who` runs, so there is no
 * second membership reader.
 *
 * AUTHORITY. Only a sender in this bridge's top-level `allowFrom` (today,
 * Monty), as for `/who`.
 *
 * THE ANSWER. A group message from him that reads `<number> yes|no|not
 * now|talk <anything>` runs `huddle answer` on the answerer's bridge, which
 * posts the one line `huddle` prints: the echo, or why nothing was recorded.
 * `huddle` decides what the words mean, never this file. The message itself
 * is NOT taken out of the chat: it goes on to the gate like any other, on
 * every bridge, so a sentence that only looks like an answer is not lost.
 * From anyone else, and from a bot, the line is ordinary chat and nothing runs.
 *
 * `--as <agent>` names this bridge's agent, because `dispatch send --from`
 * and `interrupt --by` must name the session the command runs inside.
 * `--link` is the t.me link to his message, recorded with the answer.
 */

import { homedir } from 'os'
import { join } from 'path'
import { threadKey } from './group-gate.ts'
import { WHO_ANSWERER, WHO_HEARS_BIN, WHO_TIMEOUT_MS, type CommandMessage, type OutputRunner } from './invite-excuse.ts'

export const HUDDLE_BIN = join(homedir(), '.local', 'bin', 'huddle')
export const HUDDLE_TIMEOUT_MS = 60000
/** A message of answers writes each one into its record in turn; it is never cut off part way for being slow. */
export const HUDDLE_ANSWER_TIMEOUT_MS = 300000
export const HUDDLE_MAX_STDOUT = 65536
export const NOBODY_HERE = 'Nobody hears untagged posts in this topic. Name the agents, or say fleet.'
const RC_TIMEOUT = 124
/** huddle's own exit for "nothing was recorded, and here is why": its stdout is the answer. */
const RC_NOT_RECORDED = 4
/** huddle's exit for "no line of this message is about a blocker": ordinary chat, nothing to post. */
const RC_NOT_AN_ANSWER = 5
const TELEGRAM_TEXT_MAX = 4096

export const HUDDLE_SECTIONS = ['done', 'active', 'next', 'blockers', 'status'] as const
export type HuddleSection = typeof HUDDLE_SECTIONS[number]

/** `/blockers vera grady`, `/status@MK_VeraBot fleet`: the section and the words after it, lowercased, without an @. */
export function parseHuddleCommand(text: string): { section: HuddleSection; names: string[] } | undefined {
  const m = /^\/(done|active|next|blockers|status)(?:@[A-Za-z0-9_]+)?(?=\s|$)([\s\S]*)$/i.exec(text.trim())
  if (!m) return undefined
  const names = m[2]
    .split(/[\s,]+/)
    .map(t => t.replace(/[.,!?;:]+$/, '').replace(/^@/, '').toLowerCase())
    .filter(t => /^[a-z0-9_]+$/.test(t))
  return { section: m[1].toLowerCase() as HuddleSection, names }
}

/**
 * A line that may answer a blocker: it opens with a number and has words
 * after it. One message may hold many, one to a line (Monty, 40 msg 3482).
 * What the words mean is `huddle`'s to read, in one place: this only decides
 * whether to ask it.
 */
export const HUDDLE_ANSWER_RE = /^[ \t]*#?\d+[.):,]?[ \t]+\S/m

/** His message, whole, when any line of it may answer a blocker. */
export function parseHuddleAnswer(text: string): { text: string } | undefined {
  return HUDDLE_ANSWER_RE.test(text) ? { text } : undefined
}

export type HuddleMessage = CommandMessage & { message_id?: number }

export type HuddlePlan =
  /** Neither a huddle command nor an answer this bridge acts on: the ordinary gate decides. */
  | { kind: 'none' }
  /** A huddle command this bridge does nothing about: dropped, never delivered as chat. */
  | { kind: 'ignore' }
  | { kind: 'section'; section: HuddleSection; names: string[]; chat_id: string; thread_id?: number; key: string; flat?: true }
  /** His answer, on the answerer's bridge. The message still goes to the gate. */
  | { kind: 'answer'; text: string; chat_id: string; thread_id?: number; link?: string }

export type HuddlePlanDeps = { agent: string; loadAccess: () => { allowFrom: string[] } }

/** The t.me link to a message in a supergroup, or undefined for any other chat. */
export function messageLink(chat_id: string, thread_id: number | undefined, message_id: number | undefined): string | undefined {
  const m = /^-100(\d+)$/.exec(chat_id)
  if (!m || message_id == null) return undefined
  return `https://t.me/c/${m[1]}/${thread_id != null ? `${thread_id}/` : ''}${message_id}`
}

/** Synchronous, like planGroupCommand, so the post log records the decision with the inbound line. */
export function planHuddle(deps: HuddlePlanDeps, msg: HuddleMessage): HuddlePlan {
  if (msg.chat_type !== 'group' && msg.chat_type !== 'supergroup') return { kind: 'none' }
  if (msg.text == null) return { kind: 'none' }
  const his = !!msg.from && !msg.from.is_bot && deps.loadAccess().allowFrom.includes(String(msg.from.id))
  const answerer = deps.agent === WHO_ANSWERER
  const cmd = parseHuddleCommand(msg.text)
  if (cmd) {
    if (!his || !answerer) return { kind: 'ignore' }
    return { kind: 'section', section: cmd.section, names: cmd.names, chat_id: msg.chat_id, thread_id: msg.message_thread_id, key: threadKey(msg.message_thread_id), ...(msg.is_forum ? {} : { flat: true as const }) }
  }
  const ans = parseHuddleAnswer(msg.text)
  if (!ans || !his || !answerer) return { kind: 'none' }
  const link = messageLink(msg.chat_id, msg.message_thread_id, msg.message_id)
  return { kind: 'answer', ...ans, chat_id: msg.chat_id, thread_id: msg.message_thread_id, ...(link ? { link } : {}) }
}

export type HuddleDeps = {
  agent: string
  run: OutputRunner
  /** Post into the thread. `markdown`: the text is MarkdownV2. */
  post: (chat_id: string, text: string, thread_id: number | undefined, markdown: boolean) => Promise<void>
  stderr?: (line: string) => void
  bin?: string
  whoBin?: string
  timeoutMs?: number
}

function failure(what: string, rc: number, stderr: string): string {
  const first = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0)
  return `${what} failed: ${rc === RC_TIMEOUT ? 'timed out' : (first ?? `exited ${rc}`).slice(0, 300)}`
}

/** MarkdownV2 text as plain text, for a post Telegram refused to parse. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\[(\d+)\]\(((?:\\.|[^)\\])*)\)/g, '$1').replace(/^[*_](.*)[*_]$/gm, '$1').replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1')
}

/** Whole lines packed into posts of at most `max` characters. A line is never split unless it alone is longer. */
export function chunkLines(text: string, max = TELEGRAM_TEXT_MAX): string[] {
  const out: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    const piece = line.length > max ? line.slice(0, max) : line
    if (cur.length > 0 && cur.length + 1 + piece.length > max) {
      out.push(cur)
      cur = ''
    }
    cur = cur.length > 0 ? `${cur}\n${piece}` : piece
  }
  if (cur.trim().length > 0) out.push(cur)
  return out.map(c => c.replace(/^\n+|\n+$/g, '')).filter(c => c.length > 0)
}

/**
 * Answer a section command. With no names it asks who-hears, as `/who` does.
 * Resolves 'answered' or 'failed', never rejects.
 */
export async function runHuddleSection(deps: HuddleDeps, plan: Extract<HuddlePlan, { kind: 'section' }>): Promise<'answered' | 'failed'> {
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const say = async (text: string, markdown: boolean) => {
    try {
      await deps.post(plan.chat_id, text, plan.thread_id, markdown)
    } catch (err) {
      if (!markdown) {
        stderr(`telegram channel: /${plan.section} answer failed: ${err}\n`)
        return
      }
      // Telegram refused the markup: he still gets the words.
      stderr(`telegram channel: /${plan.section} MarkdownV2 refused, sent plain: ${err}\n`)
      try {
        await deps.post(plan.chat_id, unescapeMarkdown(text), plan.thread_id, false)
      } catch (err2) {
        stderr(`telegram channel: /${plan.section} answer failed: ${err2}\n`)
      }
    }
  }
  let names = plan.names
  if (names.length === 0) {
    const w = await deps.run([deps.whoBin ?? WHO_HEARS_BIN, plan.key, '--chat', plan.chat_id, ...(plan.flat ? ['--no-forum'] : [])], WHO_TIMEOUT_MS)
    const line = w.stdout.trim().split('\n')[0] ?? ''
    names = line.split(',').map(n => n.trim()).filter(n => /^[A-Za-z0-9_]+$/.test(n))
    if (w.rc !== 0 || names.length === 0) {
      const nobody = w.rc === 0 && line.length > 0
      if (!nobody) stderr(`telegram channel: who-hears failed for /${plan.section}: rc=${w.rc} ${w.stderr}\n`)
      await say(nobody ? NOBODY_HERE : failure(`/${plan.section}`, w.rc, w.rc === 0 ? 'who-hears printed nothing' : w.stderr), false)
      return 'failed'
    }
  }
  const r = await deps.run([deps.bin ?? HUDDLE_BIN, plan.section, ...names], deps.timeoutMs ?? HUDDLE_TIMEOUT_MS, HUDDLE_MAX_STDOUT)
  const out = r.stdout.trim()
  if (r.rc !== 0 || out.length === 0) {
    stderr(`telegram channel: huddle ${plan.section} failed: rc=${r.rc} ${r.stderr}\n`)
    await say(failure(`/${plan.section}`, r.rc, r.rc === 0 ? 'no output' : r.stderr), false)
    return 'failed'
  }
  for (const chunk of chunkLines(out)) await say(chunk, true)
  return 'answered'
}

/**
 * Record his answers: `huddle answer --lines <his message> --link <his
 * message> --as <agent>`, and post what it prints, whole. Resolves
 * 'recorded', 'refused' (huddle recorded nothing and said why), 'failed', or
 * 'none' (no line was about a blocker: nothing is posted).
 */
export async function runHuddleAnswer(deps: HuddleDeps, plan: Extract<HuddlePlan, { kind: 'answer' }>): Promise<'recorded' | 'refused' | 'failed' | 'none'> {
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const argv = [deps.bin ?? HUDDLE_BIN, 'answer', '--lines', plan.text, ...(plan.link ? ['--link', plan.link] : []), ...(deps.agent && deps.agent !== '<Agent>' ? ['--as', deps.agent] : [])]
  const r = await deps.run(argv, deps.timeoutMs ?? HUDDLE_ANSWER_TIMEOUT_MS)
  if (r.rc === RC_NOT_AN_ANSWER) return 'none'
  const line = r.stdout.trim()
  const result = r.rc === 0 && line.length > 0 ? 'recorded' : r.rc === RC_NOT_RECORDED && line.length > 0 ? 'refused' : 'failed'
  if (result === 'failed') stderr(`telegram channel: huddle answer failed: rc=${r.rc} ${r.stderr}\n`)
  const text = line.length > 0 ? line.slice(0, TELEGRAM_TEXT_MAX) : failure('huddle answer', r.rc, r.rc === 0 ? 'no output' : r.stderr)
  try {
    await deps.post(plan.chat_id, text, plan.thread_id, false)
  } catch (err) {
    stderr(`telegram channel: huddle answer echo failed: ${err}\n`)
  }
  return result
}
