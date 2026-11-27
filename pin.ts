/**
 * pin_message, unpin_message and list_pins: a bot pins its own one-line
 * question to Monty in the topic where the work is, and takes it down when
 * he answers.
 *
 * Monty, 2026-11-21 (FLEET topic 1726, Telegram msg 1816): "are you able to
 * pin a post here? If so it's a good way to bring something to my attention
 * that needs me." Design: Grady.
 *
 * THE SAME RULE AS ALERTS: WHOEVER PINS, UNPINS. A pin nobody releases is a
 * standing claim on his attention that has stopped being true. So:
 *
 *   - a bot pins only a message it sent itself, and only a question on one
 *     line. Whether the question is his call (money, his name, something hard
 *     to undo, his taste) is the agent's to judge; nothing here can.
 *   - one pin per bot per topic at a time.
 *   - the bridge releases the pin when he answers it: a reply to the pinned
 *     message, a tap on one of its buttons, or a thumbs-up on it. An answer
 *     he posts without replying to the message is not seen as one; the agent
 *     calls unpin_message.
 *   - every pin is in a record in the bot's state dir, so it can be listed
 *     and released after a restart.
 *   - a pin still standing after 24 hours is filed with Page, once, as
 *     `interrupt add --tier blocker`. That is the existing rule for a
 *     question he has not answered, not a new path. The pin stays up.
 *
 * WITHOUT THE RIGHT, IT SAYS SO. In a group Telegram lets a bot pin only as
 * an administrator holding can_pin_messages. A refused pin is returned as an
 * error that names that right; it never reads as success.
 *
 * FORUM TOPICS. pinChatMessage takes a chat and a message and no thread: a
 * message in a topic is pinned in that topic. The Bot API page does not say
 * so in the method's own text; it follows from unpinAllForumTopicMessages,
 * which clears "the list of pinned messages in a forum topic".
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { isGroupChatId } from './post-log.ts'
import type { OutRunner } from './alert-tap.ts'

export const INTERRUPT_BIN = process.env.PIN_INTERRUPT_BIN ?? join(homedir(), '.local', 'bin', 'interrupt')
/** A question on one line. The Bot API sets no such limit; this is ours. */
export const PIN_QUESTION_MAX = 280
export const PIN_AGE_MS = 24 * 60 * 60 * 1000
export const PIN_SWEEP_MS = 10 * 60 * 1000
export const INTERRUPT_TIMEOUT_MS = 20_000
/** How many of this session's own sends are remembered for pinning. */
export const SENT_MAX = 500
/** The administrator right Telegram requires to pin in a group. */
export const PIN_RIGHT = 'can_pin_messages'

export type Pin = {
  chat_id: string
  /** The forum topic or message thread the question was sent in; null outside one. */
  thread_id: number | null
  message_id: number
  pinned_at: string
  question: string
  /** Set when he answered and the unpin has not gone through yet. */
  answered_at?: string
  /** Set when the pin was filed with Page at 24 hours. */
  escalated_at?: string
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const refused = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

// --- this session's own sends ------------------------------------------------

export type SentPost = { text: string; thread_id: number | undefined }

/**
 * The text and thread of each message this bridge sent, by chat and message
 * id. The Bot API cannot fetch a message, so this is the only way to know
 * that a message is this bot's own and what it says. In memory: a pin follows
 * its question within the session that asked it.
 */
export class SentPosts {
  private posts = new Map<string, SentPost>()
  constructor(private max: number = SENT_MAX) {}
  note(chat_id: string, message_id: number, post: SentPost): void {
    this.posts.set(`${chat_id}/${message_id}`, post)
    while (this.posts.size > this.max) this.posts.delete(this.posts.keys().next().value as string)
  }
  get(chat_id: string, message_id: number): SentPost | undefined {
    return this.posts.get(`${chat_id}/${message_id}`)
  }
}

/** Why this text is not one question on one line, or undefined when it is. */
export function notAQuestion(text: string): string | undefined {
  const t = text.trim()
  if (!t) return 'it is empty'
  if (/[\r\n]/.test(t)) return 'it is more than one line'
  if (t.length > PIN_QUESTION_MAX) return `it is ${t.length} characters, and a pinned question is at most ${PIN_QUESTION_MAX}`
  if (!/[?？]/.test(t)) return 'it asks nothing: there is no question mark in it'
  return undefined
}

// --- the record ----------------------------------------------------------------

export type PinStore = { load: () => Pin[]; save: (pins: Pin[]) => void }

/** The pin record, one JSON file in the bot's state dir. An unreadable file is no pins. */
export function filePinStore(file: string): PinStore {
  return {
    load: () => {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8'))
        return Array.isArray(d?.pins) ? d.pins as Pin[] : []
      } catch {
        return []
      }
    },
    save: pins => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ pins }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, file)
    },
  }
}

const same = (p: Pin, chat_id: string, message_id: number) => p.chat_id === chat_id && p.message_id === message_id

// --- the tools -------------------------------------------------------------------

export type PinApi = {
  pinChatMessage(chat_id: string, message_id: number, other: { disable_notification: boolean }): Promise<true>
  unpinChatMessage(chat_id: string, message_id: number): Promise<true>
  getMe(): Promise<{ id: number }>
  getChatMember(chat_id: string, user_id: number): Promise<{ status: string; can_pin_messages?: boolean }>
}

export type PinDeps = {
  api: PinApi
  assertAllowedChat: (chat_id: string) => void
  /** unpin_message's gate: it alone may name a private chat (private-chat.ts, 'pin-release'). Absent, the tools share one gate. */
  assertUnpinChat?: (chat_id: string) => void
  sent: SentPosts
  store: PinStore
  stderr: (s: string) => void
  now?: () => Date
}

const describe = (err: unknown): string =>
  (err as { description?: string })?.description ?? (err instanceof Error ? err.message : String(err))

/**
 * Whether this bot holds the right to pin in the chat: true, false with its
 * status, or undefined when Telegram would not say.
 */
export async function pinRight(api: PinApi, chat_id: string): Promise<{ holds: boolean; status: string } | undefined> {
  try {
    const me = await api.getMe()
    const m = await api.getChatMember(chat_id, me.id)
    if (m.status === 'creator') return { holds: true, status: m.status }
    return { holds: m.status === 'administrator' && m.can_pin_messages === true, status: m.status }
  } catch {
    return undefined
  }
}

/** The text of a refused pin or unpin. Names the missing right whenever that is the cause. */
export async function refusalText(api: PinApi, tool: string, chat_id: string, err: unknown): Promise<string> {
  const said = describe(err)
  if (isGroupChatId(chat_id)) {
    const right = await pinRight(api, chat_id)
    if (right && !right.holds) {
      const as = right.status === 'administrator' ? 'an administrator without that right' : `"${right.status}", not an administrator`
      return `${tool} failed: this bot lacks the admin right ${PIN_RIGHT} in this chat (it is ${as}). Telegram said: ${said}`
    }
    if (!right && /not enough rights|admin/i.test(said)) {
      return `${tool} failed: Telegram refused for want of rights. Pinning in a group needs the admin right ${PIN_RIGHT}. Telegram said: ${said}`
    }
  }
  return `${tool} failed: ${said}`
}

const RELEASE_HINT = 'The bridge unpins it when Monty replies to it, taps one of its buttons or puts a 👍 on it. If he answers any other way, call unpin_message.'

export async function runPinMessage(deps: PinDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const chat_id = String(args.chat_id)
  const message_id = Number(args.message_id)
  deps.assertAllowedChat(chat_id)
  if (!Number.isInteger(message_id) || message_id <= 0) {
    return refused(`pin_message refused: message_id must be a positive integer, got ${String(args.message_id)}`)
  }
  const post = deps.sent.get(chat_id, message_id)
  if (!post) {
    return refused(`pin_message refused: message ${message_id} is not one this bot sent in this session. A bot pins only its own question: send the question with reply, then pin that message.`)
  }
  const why = notAQuestion(post.text)
  if (why) {
    return refused(`pin_message refused: a pin is one question to Monty on one line, and message ${message_id} is not (${why}).`)
  }
  const pins = deps.store.load()
  if (pins.some(p => same(p, chat_id, message_id) && !p.answered_at)) {
    return ok(`already pinned (id: ${message_id})`)
  }
  const thread_id = post.thread_id ?? null
  const standing = pins.find(p => p.chat_id === chat_id && p.thread_id === thread_id && !p.answered_at)
  if (standing) {
    return refused(`pin_message refused: this bot already has a pin in this topic (message ${standing.message_id}, pinned ${standing.pinned_at}: "${standing.question}"). One pin per topic at a time: unpin_message that one first.`)
  }
  try {
    await deps.api.pinChatMessage(chat_id, message_id, { disable_notification: false })
  } catch (err) {
    return refused(await refusalText(deps.api, 'pin_message', chat_id, err))
  }
  const pin: Pin = {
    chat_id, thread_id, message_id,
    pinned_at: (deps.now ?? (() => new Date()))().toISOString(),
    question: post.text.trim(),
  }
  try {
    deps.store.save([...pins.filter(p => !same(p, chat_id, message_id)), pin])
  } catch (err) {
    // A pin with no record is one nothing would ever release. Take it down.
    await deps.api.unpinChatMessage(chat_id, message_id).catch(() => {})
    return refused(`pin_message failed: the pin record could not be written (${err}), so the message was unpinned again.`)
  }
  return ok(`pinned (id: ${message_id}). It is yours to take down. ${RELEASE_HINT} Unanswered after 24 hours, it is filed with Page.`)
}

export async function runUnpinMessage(deps: PinDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const chat_id = String(args.chat_id)
  const message_id = Number(args.message_id)
  ;(deps.assertUnpinChat ?? deps.assertAllowedChat)(chat_id)
  const pins = deps.store.load()
  if (!pins.some(p => same(p, chat_id, message_id))) {
    return refused(`unpin_message refused: this bot has no pin on record for message ${message_id} in that chat. It unpins only what it pinned; list_pins shows those.`)
  }
  const drop = () => deps.store.save(pins.filter(p => !same(p, chat_id, message_id)))
  try {
    await deps.api.unpinChatMessage(chat_id, message_id)
  } catch (err) {
    // Already down (he unpinned it, or the message is gone): the record goes too.
    if (/not pinned|not found|MESSAGE_ID_INVALID/i.test(describe(err))) {
      drop()
      return ok(`released (id: ${message_id}): Telegram says it was no longer pinned (${describe(err)})`)
    }
    return refused(await refusalText(deps.api, 'unpin_message', chat_id, err))
  }
  drop()
  return ok(`unpinned (id: ${message_id})`)
}

export function runListPins(deps: Pick<PinDeps, 'store'>): ToolResult {
  const pins = deps.store.load()
  if (pins.length === 0) return ok('no pins')
  return ok(JSON.stringify(pins, null, 2))
}

// --- release on his answer ---------------------------------------------------------

export type ReleaseDeps = Pick<PinDeps, 'api' | 'store' | 'stderr' | 'now'>

/**
 * Monty answered a message: a reply to it, a tap on its button, a thumbs-up.
 * If it is one of this bot's pins, unpin it. Resolves true when it was a pin
 * (released, or marked answered for the sweep to retry); never rejects.
 */
export async function releaseOnAnswer(deps: ReleaseDeps, a: { chat_id: string; message_id: number; how: 'reply' | 'tap' | 'thumbs-up' }): Promise<boolean> {
  let pins: Pin[]
  try { pins = deps.store.load() } catch { return false }
  const pin = pins.find(p => same(p, a.chat_id, a.message_id))
  if (!pin) return false
  const rest = pins.filter(p => p !== pin)
  try {
    await deps.api.unpinChatMessage(a.chat_id, a.message_id)
    deps.store.save(rest)
    deps.stderr(`pin: message ${a.message_id} unpinned on his answer (${a.how})\n`)
  } catch (err) {
    deps.stderr(`pin: he answered message ${a.message_id} (${a.how}) and the unpin failed, will retry: ${describe(err)}\n`)
    try {
      deps.store.save([...rest, { ...pin, answered_at: pin.answered_at ?? (deps.now ?? (() => new Date()))().toISOString() }])
    } catch (e) {
      deps.stderr(`pin: record write failed: ${e}\n`)
    }
  }
  return true
}

// --- the sweep: retry a failed release, file a 24h pin with Page ---------------------

export type SweepDeps = ReleaseDeps & {
  run: OutRunner
  /** This bridge's agent, as the claude() wrapper verified it, or '<Agent>'. */
  agent: string
}

export async function sweepPins(deps: SweepDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  let pins: Pin[]
  try { pins = deps.store.load() } catch { return }
  if (pins.length === 0) return
  const next: Pin[] = []
  for (const pin of pins) {
    if (pin.answered_at) {
      try {
        await deps.api.unpinChatMessage(pin.chat_id, pin.message_id)
      } catch (err) {
        if (!/not pinned|not found|MESSAGE_ID_INVALID/i.test(describe(err))) {
          deps.stderr(`pin: unpin of answered message ${pin.message_id} still failing: ${describe(err)}\n`)
          next.push(pin)
        }
      }
      continue
    }
    if (!pin.escalated_at && now.getTime() - Date.parse(pin.pinned_at) >= PIN_AGE_MS) {
      if (deps.agent === '<Agent>') {
        deps.stderr(`pin: message ${pin.message_id} has stood 24h and this bridge's agent name is unverified, so it cannot be filed with Page\n`)
      } else {
        const where = pin.thread_id != null ? `topic ${pin.thread_id}` : 'a direct chat'
        const r = await deps.run([
          INTERRUPT_BIN, 'add', '--tier', 'blocker', '--from', deps.agent,
          '--text', `Pinned for Monty in ${where} and unanswered for 24 hours: ${pin.question}`,
        ], undefined, INTERRUPT_TIMEOUT_MS).catch(e => ({ rc: 127, stdout: '', stderr: String(e) }))
        if (r.rc === 0) {
          next.push({ ...pin, escalated_at: now.toISOString() })
          continue
        }
        deps.stderr(`pin: filing message ${pin.message_id} with Page failed (rc=${r.rc}), will retry: ${r.stderr.trim().split('\n').pop() ?? ''}\n`)
      }
    }
    next.push(pin)
  }
  if (JSON.stringify(next) !== JSON.stringify(pins)) {
    try { deps.store.save(next) } catch (e) { deps.stderr(`pin: record write failed: ${e}\n`) }
  }
}
