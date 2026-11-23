/**
 * Every reaction from Monty in a group, handed to the fleet's one reaction log.
 *
 * WHY. A reaction update reaches at most the bots that are administrators in
 * the group, each hands it to its own session, and nothing recorded it
 * anywhere else. Werner's bot never received Monty's reactions, so a thumbs-up
 * he gave Werner went unacted (2026-11-23). With one shared log no agent
 * depends on its own bot receiving the update: it asks `monty-reactions`.
 * Grady's brief of 2026-11-23, class 2 batch 2, item 2, as widened that day.
 *
 * THE BRIDGE DOES NOT WRITE THE LOG. It runs `monty-reactions --append` with
 * one JSON line on stdin, and that script owns the log: it is one file on
 * maxi, the script re-invokes itself there from another host, and it drops a
 * line already written by another bot, since every admin bot is sent the same
 * update. So the dedupe is in one place and is the same from every host.
 *
 * WHICH REACTIONS. From a user in this bridge's own allowFrom, in a group or
 * supergroup, added and removed alike. Every topic, not only Page's alert
 * topics: alert-tap.ts still writes those to the tap log for the
 * acknowledgement path, and that log is untouched.
 *
 * It only logs. A failure is one stderr line; the session still gets the
 * reaction and nothing waits on this.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import { homedir } from 'os'
import { join } from 'path'
import type { OutRunner } from './alert-tap.ts'
import { isGroupChatId } from './post-log.ts'

export const MONTY_REACTIONS_BIN = process.env.MONTY_REACTIONS_BIN ?? join(homedir(), '.local', 'bin', 'monty-reactions')
export const REACTION_APPEND_TIMEOUT_MS = 20_000

export type ReactionLogSinkDeps = {
  run: OutRunner
  /** Monty's user ids, from this bridge's own access config. Never written here. */
  allowFrom: () => string[]
  /** This bridge's bot username, once polling has started. */
  bot: () => string
  /** This bridge's agent, as the claude() wrapper verified it, or '<Agent>'. */
  agent: string
  stderr: (s: string) => void
  bin?: string
}

export type ReactionEvent = {
  chat_id: string
  message_id: number
  emoji: string
  action: string
  user_id: string
  /** Telegram's own time for the change, ISO. The same on every bot that is sent it. */
  ts: string
}

/** The line handed to `monty-reactions --append`. */
export function reactionLine(deps: Pick<ReactionLogSinkDeps, 'bot' | 'agent'>, r: ReactionEvent): Record<string, unknown> {
  return {
    ts: r.ts, chat_id: r.chat_id, message_id: r.message_id, emoji: r.emoji, action: r.action,
    user_id: r.user_id, bot: deps.bot() || null, agent: deps.agent,
  }
}

/** Returns true when the line was handed over and the script took it. Never rejects. */
export async function logMontyReaction(deps: ReactionLogSinkDeps, r: ReactionEvent): Promise<boolean> {
  if (!deps.allowFrom().includes(r.user_id)) return false
  if (!isGroupChatId(r.chat_id)) return false
  const line = JSON.stringify(reactionLine(deps, r)) + '\n'
  let res: { rc: number; stdout: string; stderr: string }
  try {
    res = await deps.run([deps.bin ?? MONTY_REACTIONS_BIN, '--append'], line, REACTION_APPEND_TIMEOUT_MS)
  } catch (e) {
    res = { rc: 127, stdout: '', stderr: String(e) }
  }
  if (res.rc !== 0) {
    deps.stderr(`reaction log: monty-reactions --append failed (rc=${res.rc}): ${res.stderr.trim().split('\n').pop() ?? ''}\n`)
    return false
  }
  return true
}
