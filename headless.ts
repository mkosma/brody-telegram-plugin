/**
 * The bridge's headless mode: TELEGRAM_HEADLESS=1, a poller with no session.
 *
 * RULING-page-taps-need-a-poller-2026-11-09 (Grady). Page sends as its own
 * bot, and a tap is delivered to the bot that sent the message, so a button
 * on a Page message is answered only if something polls Page's token. No
 * agent session does. This mode is that poller, run by launchd: the same
 * server.ts, the same tap handlers, with the session-shaped parts left off.
 *
 * WHAT IS LEFT OFF. No MCP connection, no stdin end/close shutdown, no orphan
 * watchdog: under launchd there is no MCP client, stdin is /dev/null and the
 * parent is launchd itself, so each of those would end the process at once
 * and KeepAlive would flap it. It still polls, still writes poll.heartbeat,
 * and still takes over bot.pid the same way agent mode does.
 *
 * WHAT IS HANDLED. A button tap whose data the existing server-side handlers
 * serve (`omf:` then `pg:`) passes through to them unchanged, gate and toasts
 * included. A DM from allowFrom gets one fixed line, at most once an hour per
 * chat. Everything else is dropped as the gate drops it. Nothing is ever
 * delivered to a session, because there is none.
 *
 * ONE POLLER PER TOKEN. A 409 means something else holds the token. Fighting
 * it would starve both, and exiting at once would make launchd relaunch into
 * the same 409 every ten seconds, so the bridge logs, sleeps long, and exits 0.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import { parsePageTap } from './page-tap.ts'

export function isHeadless(env: Record<string, string | undefined>): boolean {
  return env.TELEGRAM_HEADLESS === '1'
}

/** Open question 2 of the ruling: the one reply a DM gets. */
export const HEADLESS_DM_REPLY = "Page doesn't read messages. Tap a button, or talk to Vera."

/** At most one fixed reply per chat in this window. */
export const DM_REPLY_EVERY_MS = 60 * 60 * 1000

/** The toast for a tap no headless handler serves, so it never spins. */
export const HEADLESS_UNSERVED_TOAST = 'Nothing here answers that button.'

/** How long a headless bridge waits after a 409 before it exits 0. */
export const CONFLICT_SLEEP_DEFAULT_MS = 5 * 60 * 1000

export function conflictSleepMs(env: Record<string, string | undefined>): number {
  const raw = env.TELEGRAM_CONFLICT_SLEEP_MS
  if (!raw) return CONFLICT_SLEEP_DEFAULT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : CONFLICT_SLEEP_DEFAULT_MS
}

/** The callback data the existing server-side handlers serve without a session. */
export function servedHeadless(data: string): boolean {
  return /^omf:([0-9a-f]{6,16})$/.test(data) || parsePageTap(data) !== undefined
}

/** Remembers when each chat last got the fixed reply. Per process. */
export class DmReplyLimiter {
  private last = new Map<string, number>()
  constructor(private everyMs = DM_REPLY_EVERY_MS) {}
  take(chat_id: string, now: number): boolean {
    const prev = this.last.get(chat_id)
    if (prev !== undefined && now - prev < this.everyMs) return false
    this.last.set(chat_id, now)
    return true
  }
}

export type HeadlessUpdate = {
  /** callback_query.data, when the update is a button tap with data. */
  callbackData?: string
  isCallback: boolean
  /** True for a `message` update (not an edit, not a reaction). */
  isMessage: boolean
  chatType?: string
  fromId?: number | string
}

export type HeadlessAction =
  | { kind: 'pass' }
  | { kind: 'refuse-tap'; toast: string }
  | { kind: 'dm-reply'; text: string }
  | { kind: 'drop'; why: string }

/**
 * What a headless bridge does with one update. 'pass' hands it to the
 * existing handlers, which apply their own allowFrom gate. Taking the reply
 * slot is a side effect on `limiter`, so call this once per update.
 */
export function headlessDecision(
  u: HeadlessUpdate,
  allowFrom: string[],
  limiter: DmReplyLimiter,
  now: number,
): HeadlessAction {
  const from = u.fromId != null ? String(u.fromId) : ''
  if (u.isCallback) {
    if (u.callbackData !== undefined && servedHeadless(u.callbackData)) return { kind: 'pass' }
    if (!from || !allowFrom.includes(from)) return { kind: 'refuse-tap', toast: 'Not authorized.' }
    return { kind: 'refuse-tap', toast: HEADLESS_UNSERVED_TOAST }
  }
  if (u.isMessage && u.chatType === 'private') {
    if (!from || !allowFrom.includes(from)) return { kind: 'drop', why: 'dm-not-allowed' }
    // A DM's chat id is the sender's user id, so this is per chat.
    if (!limiter.take(from, now)) return { kind: 'drop', why: 'dm-replied-this-hour' }
    return { kind: 'dm-reply', text: HEADLESS_DM_REPLY }
  }
  return { kind: 'drop', why: 'headless' }
}
