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
 */

import { threadKey, type GroupPolicy } from './group-gate.ts'

export type Verb = 'invite' | 'excuse'

export const STATIC_ANSWER = "I can't change my settings in this mode."

/**
 * `/invite @a b`, `/excuse@MK_ABot`: the verb and the names it carries,
 * lowercased, without the @. The @ is optional. The text after the verb is
 * split on whitespace and commas, and a token is a name only when the whole
 * of it, less trailing punctuation, is `@?[A-Za-z0-9_]+`: `x@grady.com`
 * names nobody.
 */
export function parseGroupCommand(text: string): { verb: Verb; names: string[] } | undefined {
  const m = /^\/(invite|excuse)(?:@([A-Za-z0-9_]+))?(?=\s|$)([\s\S]*)$/i.exec(text.trim())
  if (!m) return undefined
  const names = m[3]
    .split(/[\s,]+/)
    .map(t => t.replace(/[.,!?;:]+$/, ''))
    .filter(t => /^@?[A-Za-z0-9_]+$/.test(t))
    .map(t => t.replace(/^@/, '').toLowerCase())
  if (m[2]) names.unshift(m[2].toLowerCase())
  return { verb: m[1].toLowerCase() as Verb, names }
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
  /** Not an /invite or /excuse in a group: the ordinary gate decides. */
  | { kind: 'none' }
  /** A command this bridge does nothing about: not its name, not an allowFrom sender, or no name at all. */
  | { kind: 'ignore' }
  | { kind: 'act'; verb: Verb; chat_id: string; thread_id?: number; key: string }

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
  if (!cmd.names.some(n => mine.has(n))) return { kind: 'ignore' }
  return { kind: 'act', verb: cmd.verb, chat_id: msg.chat_id, thread_id: msg.message_thread_id, key: threadKey(msg.message_thread_id) }
}

export type CommandResult = 'changed' | 'unchanged' | 'static' | 'failed'

export async function runGroupCommand<A extends CommandAccess>(deps: CommandDeps<A>, plan: Extract<CommandPlan, { kind: 'act' }>): Promise<CommandResult> {
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const say = async (text: string) => {
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
  try {
    deps.notify(plan.verb, plan.key)
  } catch (err) {
    stderr(`telegram channel: /${plan.verb} not delivered to the session: ${err}\n`)
  }
  return changed ? 'changed' : 'unchanged'
}
