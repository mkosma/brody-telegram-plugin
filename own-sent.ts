/**
 * A reaction reaches only the session whose bot posted the message.
 *
 * WHY. Telegram sends a `message_reaction` update for every message in a group
 * to every bot that is an administrator there, and the bridge handed each one
 * to its session whoever had posted the message. One reaction of Monty's on
 * Maya's now-playing post was a turn in Grady's session and in Vera's too
 * (2026-11-24, message 2420). The fleet's one reaction log (reaction-log.ts)
 * already records every reaction from whichever bot receives it, so a session
 * loses nothing by not being handed a reaction on a peer's message.
 * Grady's BRIEF-reactions-reach-only-the-poster-2026-11-24.
 *
 * A REACTION IS OURS when the chat is private, or this bot sent the message,
 * or the message is a pin this bot holds. Anything else is one line in the
 * bot's post log and no turn.
 *
 * HOW THE BRIDGE KNOWS WHAT IT SENT. An in-memory set of (chat_id, message_id),
 * grown by every `dir:"out"` line the bridge writes to its post log, and
 * seeded at startup from this bot's own post log on this host. Never another
 * bot's file and never another host: a bot's own out records are on its own
 * host by construction.
 *
 * IT FAILS TOWARD DELIVERING. Until the set is seeded, and for good when the
 * post log cannot be read, every reaction is handed to the session as before.
 * A missed reaction on our own question is worse than a spare turn.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { isGroupChatId, type Tee } from './post-log.ts'

/** The seed reads at most this many of the bot's latest out records, and the set holds no more. */
export const OWN_SENT_MAX = 10_000
/** The seed skips an out record older than this. */
export const OWN_SENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type SeedOpts = {
  dir: string
  bot: string
  read?: (file: string) => string
  now?: () => Date
  stderr: (s: string) => void
}

const ownKey = (chat_id: string | number, message_id: number | string) => `${chat_id}/${message_id}`

export class OwnSent {
  private keys = new Set<string>()
  private isSeeded = false
  constructor(private max: number = OWN_SENT_MAX) {}

  get seeded(): boolean { return this.isSeeded }
  get size(): number { return this.keys.size }

  note(chat_id: string | number, message_id: number): void {
    const k = ownKey(chat_id, message_id)
    // Re-noting (an edit) makes it the newest, so it is the last to be dropped.
    this.keys.delete(k)
    this.keys.add(k)
    while (this.keys.size > this.max) this.keys.delete(this.keys.values().next().value as string)
  }

  has(chat_id: string | number, message_id: number): boolean {
    return this.keys.has(ownKey(chat_id, message_id))
  }

  /**
   * Read this bot's own post log, the rotated generation first, and note its
   * out records: those inside the age bound, and of those the latest `max`.
   * A file that is not there is a bot that has posted nothing, which is a
   * good seed. Any other read failure leaves the set unseeded, says so once,
   * and returns false.
   */
  seed(opts: SeedOpts): boolean {
    const read = opts.read ?? ((f: string) => readFileSync(f, 'utf8'))
    const oldest = (opts.now ?? (() => new Date()))().getTime() - OWN_SENT_MAX_AGE_MS
    const file = join(opts.dir, `${opts.bot}.jsonl`)
    const found: Array<[string, number]> = []
    try {
      for (const f of [`${file}.1`, file]) {
        let text: string
        try {
          text = read(f)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw e
        }
        for (const line of text.split('\n')) {
          if (!line.includes('"dir":"out"')) continue
          let r: Record<string, unknown>
          try { r = JSON.parse(line) } catch { continue }
          if (r.dir !== 'out' || typeof r.message_id !== 'number' || r.chat_id == null) continue
          if (r.bot != null && r.bot !== opts.bot) continue
          const at = Date.parse(String(r.ts))
          if (!(at >= oldest)) continue
          found.push([String(r.chat_id), r.message_id])
        }
      }
    } catch (e) {
      opts.stderr(`telegram channel: own post log unreadable, so every reaction goes to the session: ${e}\n`)
      return false
    }
    // Before anything sent since launch, so those stay the newest.
    const since = [...this.keys]
    this.keys.clear()
    for (const [chat_id, message_id] of found.slice(-this.max)) this.note(chat_id, message_id)
    for (const k of since) { this.keys.delete(k); this.keys.add(k) }
    while (this.keys.size > this.max) this.keys.delete(this.keys.values().next().value as string)
    this.isSeeded = true
    return true
  }

  /** The same tee, noting every out line handed to it, whether or not the write lands. */
  wrap(tee: Tee): Tee {
    return entry => {
      if (entry.dir === 'out' && typeof entry.message_id === 'number' && entry.chat_id != null) {
        this.note(String(entry.chat_id), entry.message_id)
      }
      tee(entry)
    }
  }
}

export type OursDeps = {
  own: OwnSent
  /** The pins this bot holds (pin.ts). A record that cannot be read is no pins. */
  pins: () => Array<{ chat_id: string; message_id: number }>
}

/** Why this reaction goes to the session, or undefined when the message is not ours. */
export function reactionIsOurs(deps: OursDeps, chat_id: string, message_id: number): 'private' | 'unseeded' | 'own-sent' | 'pin' | undefined {
  if (!isGroupChatId(chat_id)) return 'private'
  if (!deps.own.seeded) return 'unseeded'
  if (deps.own.has(chat_id, message_id)) return 'own-sent'
  let pins: Array<{ chat_id: string; message_id: number }> = []
  try { pins = deps.pins() } catch {}
  if (pins.some(p => p.chat_id === chat_id && p.message_id === message_id)) return 'pin'
  return undefined
}

/**
 * The post-log line for a reaction that was not handed to the session.
 *
 * The message is named in `reaction_to` and the user in `user_id`, not in
 * `message_id` and `from_id`: the log's readers take a `dir:"in"` line with
 * those two as a post of his, and a reaction is not a post.
 */
export function notOursEntry(r: { chat_id: string; message_id: number; emoji: string; action: string; user_id: string; ts?: string }): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    dir: 'in',
    type: 'reaction',
    chat_id: r.chat_id,
    reaction_to: r.message_id,
    emoji: r.emoji,
    action: r.action,
    user_id: r.user_id,
    reacted_at: r.ts ?? null,
    delivered: false,
    reason: 'not-ours',
  }
}
