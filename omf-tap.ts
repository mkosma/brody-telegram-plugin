/**
 * The server-side open of an `omf:<id>` button tap, and the one reply that
 * says so when the open fails.
 *
 * WHY THE REPLY. The tap is toasted ("Opening x") before open-markdown-file
 * runs, so a failed open used to reach only this process's stderr: Monty
 * tapped, saw the toast, and nothing opened, with no explanation. Now a
 * nonzero exit or a timeout posts one short line into the tapped message's
 * chat and thread. Success posts nothing. The open is never retried, and the
 * reply is sent after the open has finished, so it cannot delay it.
 *
 * NO PATHS. The reason is the first line of the script's stderr with every
 * absolute path removed, because a message to Monty carries no file paths.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import type { Runner } from './tag-relay.ts'

export const OMF_BIN = '/Users/monty/.local/bin/open-markdown-file'
export const OMF_TIMEOUT_MS = 15000
export const REASON_MAX = 120

/** spawnRunner's exit code for a process it killed at the timeout. */
const RC_TIMEOUT = 124

type Button = { text?: string; callback_data?: string }
type ReplyMarkup = { inline_keyboard?: Button[][] } | undefined

/** The tapped button's own text, found by its callback data. */
export function tappedLabel(data: string, replyMarkup: ReplyMarkup): string | undefined {
  return (replyMarkup?.inline_keyboard ?? []).flat().find(b => b?.callback_data === data)?.text || undefined
}

/**
 * Remove absolute paths: a quoted one whole, spaces and all, and an unquoted
 * one up to the next space, quote or closing `)`, `]`, `,`, `;`. `~/x`
 * counts. `and/or` and a vault-relative `WIP:Vera/x.md` do not start a
 * path.
 */
export function stripPaths(s: string): string {
  return s
    .replace(/'~?\/[^']*'|"~?\/[^"]*"|`~?\/[^`]*`|(?<![\w.~-])~?\/[^\s'"`)\],;]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of Array.from(s)) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}

export function failureReason(rc: number, stderr: string): string {
  if (rc === RC_TIMEOUT) return `timed out after ${OMF_TIMEOUT_MS / 1000}s`
  const first = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return cut(stripPaths(first), REASON_MAX) || `exited ${rc}`
}

export type OmfTapDeps = {
  run: Runner
  send: (chat_id: string, text: string, thread_id: number | undefined) => Promise<unknown>
  stderr: (s: string) => void
}

export type OmfTap = {
  target: string
  label: string | undefined
  /** Absent when the tapped message cannot be found; then nothing is posted. */
  chat_id: string | undefined
  thread_id: number | undefined
}

/** Run the open; on failure post one reply. Resolves 'opened' or 'failed', never rejects. */
export async function openTapped(deps: OmfTapDeps, tap: OmfTap): Promise<'opened' | 'failed'> {
  const r = await deps.run([OMF_BIN, tap.target, '--clicked', '--quiet'], undefined, OMF_TIMEOUT_MS)
  if (r.rc === 0) return 'opened'
  deps.stderr(`omf open failed: rc=${r.rc} ${r.stderr}\n`)
  if (tap.chat_id == null) return 'failed'
  const text = `Couldn't open ${tap.label ?? 'that document'}: ${failureReason(r.rc, r.stderr)}`
  try {
    await deps.send(tap.chat_id, text, tap.thread_id)
  } catch (e) {
    deps.stderr(`omf failure reply not sent: ${e}\n`)
  }
  return 'failed'
}
