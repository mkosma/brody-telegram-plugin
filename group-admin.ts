/**
 * Is this bot an administrator in each group it serves? Asked once at startup
 * and written where anyone can read it.
 *
 * WHY. Telegram sends `message_reaction` updates only to a bot that is an
 * administrator in the chat. Whether a given bot is one was known to nobody:
 * Werner's bot never received Monty's reactions and nothing said why
 * (2026-11-23). The right is Monty's group setting and this changes nothing;
 * it reports. Grady's brief of 2026-11-23, class 2 batch 2, item 2.
 *
 * WHAT IT WRITES. One stderr line per group, and ONE line of JSON to
 * <post-log dir>/<bot>.admin.json, replaced whole on each start:
 *   { ts, bot, agent, chats: { "<chat id>": { status, is_admin,
 *       receives_reactions, can_pin_messages, can_delete_messages,
 *       can_manage_topics } | { error } } }
 * `receives_reactions` is `is_admin`: that is the whole condition on the
 * chat's side. The other half, `message_reaction` in allowed_updates, the
 * bridge already asks for on every start.
 *
 * A group that cannot be asked about is recorded with its error, never left
 * out: an absent chat would read as "not in that group".
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export type Member = {
  status?: string
  can_pin_messages?: boolean
  can_delete_messages?: boolean
  can_manage_topics?: boolean
}

export type AdminStatus = {
  status: string
  is_admin: boolean
  receives_reactions: boolean
  can_pin_messages: boolean
  can_delete_messages: boolean
  can_manage_topics: boolean
}

export type GroupAdminDeps = {
  getChatMember: (chat_id: string, user_id: number) => Promise<Member>
  /** Group chat ids this bridge serves, from its own access config. */
  groups: () => string[]
  bot: string
  bot_id: number
  agent: string
  dir: string
  stderr: (s: string) => void
  write?: (file: string, text: string) => void
  now?: () => Date
}

export function adminStatus(m: Member): AdminStatus {
  const status = m.status ?? 'unknown'
  // The creator holds every right; an administrator holds the ones granted.
  const creator = status === 'creator'
  const is_admin = creator || status === 'administrator'
  return {
    status, is_admin, receives_reactions: is_admin,
    can_pin_messages: creator || (is_admin && m.can_pin_messages === true),
    can_delete_messages: creator || (is_admin && m.can_delete_messages === true),
    can_manage_topics: creator || (is_admin && m.can_manage_topics === true),
  }
}

export function adminStatusFile(dir: string, bot: string): string {
  return join(dir, `${bot}.admin.json`)
}

const writeWhole = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/** Ask about every group, say so on stderr, write the one line. Never rejects. */
export async function recordGroupAdmin(deps: GroupAdminDeps): Promise<Record<string, AdminStatus | { error: string }>> {
  const chats: Record<string, AdminStatus | { error: string }> = {}
  for (const chat of deps.groups()) {
    try {
      const s = adminStatus(await deps.getChatMember(chat, deps.bot_id))
      chats[chat] = s
      deps.stderr(`telegram channel: @${deps.bot} in ${chat}: ${s.status}${s.is_admin ? '' : ' (NOT an administrator: Telegram sends this bot no reactions from this chat)'}\n`)
    } catch (e) {
      chats[chat] = { error: String(e instanceof Error ? e.message : e).slice(0, 200) }
      deps.stderr(`telegram channel: @${deps.bot} in ${chat}: could not ask whether it is an administrator: ${e}\n`)
    }
  }
  const line = JSON.stringify({ ts: (deps.now ?? (() => new Date()))().toISOString(), bot: deps.bot, agent: deps.agent, chats }) + '\n'
  try {
    (deps.write ?? writeWhole)(adminStatusFile(deps.dir, deps.bot), line)
  } catch (e) {
    deps.stderr(`telegram channel: could not write the admin status file: ${e}\n`)
  }
  return chats
}
