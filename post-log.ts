/**
 * The post log (the tee): one JSON line per group post this bridge sends or
 * receives, appended to a file of its own, ~/.agents/telegram-tee/<bot>.jsonl.
 * `tail-fleet-posts` (monty-ops) merges every bot's file into one timeline.
 *
 * Spec: agents/Grady/design/SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09,
 * item 1.
 *
 * WHY ONE FILE PER BOT. Two bridges never append to the same file, so there is
 * no interleaving question and rotation can never race another writer.
 *
 * WHY IT CANNOT FAIL A SEND. Every write is local disk, inside try/catch, and a
 * failure costs one stderr line. No bridge writes to another host's disk: the
 * reply path must not gain an NFS dependency it did not have.
 *
 * GROUPS ONLY. A DM to an agent stays between Monty and that agent, so a DM is
 * never written here, in either direction.
 */

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const TEE_MAX_BYTES = 10 * 1024 * 1024

export const TEE_DIR = process.env.TELEGRAM_TEE_DIR ?? join(homedir(), '.agents', 'telegram-tee')

export type TeeFs = {
  mkdirSync: typeof mkdirSync
  chmodSync: typeof chmodSync
  statSync: typeof statSync
  renameSync: typeof renameSync
  appendFileSync: typeof appendFileSync
}

const realFs: TeeFs = { mkdirSync, chmodSync, statSync, renameSync, appendFileSync }

export type Tee = (entry: Record<string, unknown>) => void

/**
 * Telegram chat ids: a user (so a DM) is positive, a group or supergroup is
 * negative. The outbound tools are handed only a chat_id, so this is how the
 * reply path tells a group from a DM without an extra API call.
 */
export function isGroupChatId(chat_id: string | number): boolean {
  return /^-\d+$/.test(String(chat_id))
}

export function isGroupChatType(type: string | undefined): boolean {
  return type === 'group' || type === 'supergroup'
}

export function makeTee(opts: {
  dir: string
  bot: () => string
  fs?: TeeFs
  maxBytes?: number
  stderr?: (line: string) => void
}): Tee {
  const fs = opts.fs ?? realFs
  const max = opts.maxBytes ?? TEE_MAX_BYTES
  const stderr = opts.stderr ?? ((l: string) => { process.stderr.write(l) })
  return entry => {
    try {
      const bot = opts.bot()
      // Before polling starts the bridge does not know its own username, so it
      // has no file to name. Say so rather than invent one.
      if (!bot) throw new Error('bot username not known yet')
      fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(opts.dir, 0o700)
      const file = join(opts.dir, `${bot}.jsonl`)
      try {
        // One generation, as chronometer does: the old .1 is replaced.
        if (fs.statSync(file).size >= max) fs.renameSync(file, `${file}.1`)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      fs.appendFileSync(file, JSON.stringify({ ...entry, bot }) + '\n', { mode: 0o600 })
    } catch (err) {
      stderr(`telegram channel: post log write failed (send unaffected): ${err}\n`)
    }
  }
}

/** Never let a tee throw into its caller, whatever tee it was handed. */
export function safeTee(tee: Tee | undefined, entry: Record<string, unknown>): void {
  if (!tee) return
  try { tee(entry) } catch {}
}

export function outEntry(p: {
  chat_id: string
  thread_id?: number
  message_id: number
  reply_to?: number
  text: string
  edit: boolean
}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    dir: 'out',
    chat_id: p.chat_id,
    thread_id: p.thread_id ?? null,
    message_id: p.message_id,
    reply_to: p.reply_to ?? null,
    text: p.text,
    edit: p.edit,
  }
}

type InboundMessage = {
  message_id?: number
  message_thread_id?: number
  reply_to_message?: { message_id?: number }
}
type InboundChat = { id: number | string; type?: string }
type InboundFrom = { id: number; username?: string; first_name?: string; is_bot?: boolean }

/**
 * Run the inbound gate and log the message whatever the gate decides. The log
 * line is written even when `decide` throws, so a message the gate drops, or
 * chokes on, is still on the record with delivered:false.
 */
export function teeInbound<R extends { action: string }>(
  p: {
    message: InboundMessage | undefined
    chat: InboundChat | undefined
    from: InboundFrom | undefined
    text: string
    tee: Tee | undefined
  },
  decide: () => R,
): R {
  let result: R | undefined
  try {
    result = decide()
    return result
  } finally {
    if (p.chat && isGroupChatType(p.chat.type)) {
      safeTee(p.tee, {
        ts: new Date().toISOString(),
        dir: 'in',
        chat_id: String(p.chat.id),
        thread_id: p.message?.message_thread_id ?? null,
        message_id: p.message?.message_id ?? null,
        reply_to: p.message?.reply_to_message?.message_id ?? null,
        from_user: p.from?.username ?? p.from?.first_name ?? null,
        from_id: p.from != null ? String(p.from.id) : null,
        from_is_bot: p.from?.is_bot ?? false,
        text: p.text,
        delivered: result?.action === 'deliver',
      })
    }
  }
}
