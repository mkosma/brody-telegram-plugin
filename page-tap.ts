/**
 * Page's Done and Not now buttons, served server-side.
 *
 * Rule 5 of DESIGN-page-tuned-2026-10-05 (Grady), approved by Monty
 * 2026-11-09. Every item on a Page digest carries `pg:done:<id>` and
 * `pg:later:<id>`. A tap runs `interrupt tap <verb> <id> --tg-user <id>`,
 * which records it in Page's store, and is answered with that command's own
 * toast. It never waits on an agent's turn, like the `omf:` open button.
 *
 * AFTER A TAP THE ITEM'S ROW GOES. Done, Not now and "already closed" all
 * mean the pair has nothing left to do, so the tapped message is edited to
 * drop that item's row and a second tap is not offered. A refusal (the
 * document is still on his desk) or a failure leaves the row, so he can tap
 * again once the cause is gone.
 *
 * STYLES ARE RE-STATED ON THE EDIT. An edit replaces the whole keyboard, and
 * a button without a `style` renders near-invisible on his macOS client, so
 * every button kept is given its style again rather than trusting the copy
 * Telegram returned.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import type { Runner } from './tag-relay.ts'
import { stripPaths } from './omf-tap.ts'

export const INTERRUPT_BIN = '/Users/monty/.local/bin/interrupt'
export const PAGE_TAP_TIMEOUT_MS = 10000
export const TOAST_MAX = 190

/** `interrupt tap` exit codes. */
export const RC = { OK: 0, NOT_OPEN: 3, ON_DESK: 4, TIMEOUT: 124 } as const

export type PageTapVerb = 'done' | 'later'

/** `pg:done:P0123` -> { verb, id }. Anything else is not a Page tap. */
export function parsePageTap(data: string): { verb: PageTapVerb; id: string } | undefined {
  const m = /^pg:(done|later):(P[0-9]{4,6})$/.exec(data)
  return m ? { verb: m[1] as PageTapVerb, id: m[2] } : undefined
}

export type Button = { text?: string; callback_data?: string; style?: string }
export type Markup = { inline_keyboard?: Button[][] } | undefined

function styleFor(b: Button): string {
  if (b.callback_data?.startsWith('pg:done:')) return 'success'
  if (b.callback_data?.startsWith('pg:later:')) return 'primary'
  return b.style || 'primary'
}

/** The keyboard without `id`'s Done / Not now, every kept button styled. */
export function withoutItem(markup: Markup, id: string): { inline_keyboard: Button[][] } {
  const mine = new Set([`pg:done:${id}`, `pg:later:${id}`])
  const rows = (markup?.inline_keyboard ?? [])
    .map(row => row.filter(b => !mine.has(b.callback_data ?? '')))
    .filter(row => row.length > 0)
    .map(row => row.map(b => ({ ...b, style: styleFor(b) })))
  return { inline_keyboard: rows }
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

function firstLine(s: string): string {
  return s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
}

export type PageTapOutcome = 'done' | 'later' | 'closed' | 'refused' | 'failed'

/** What the tap did, and the toast that says so. Never contains a path. */
export function tapResult(verb: PageTapVerb, id: string, rc: number, stderr: string): { outcome: PageTapOutcome; toast: string } {
  const said = cut(stripPaths(firstLine(stderr)), TOAST_MAX)
  if (rc === RC.OK) return { outcome: verb, toast: said || (verb === 'done' ? `${id} done` : `${id} hidden for 3 days`) }
  if (rc === RC.NOT_OPEN) return { outcome: 'closed', toast: said || `${id} is already closed` }
  if (rc === RC.ON_DESK) return { outcome: 'refused', toast: said || `${id} is still on your desk` }
  if (rc === RC.TIMEOUT) return { outcome: 'failed', toast: `Couldn't confirm ${id}: no answer in ${PAGE_TAP_TIMEOUT_MS / 1000}s` }
  return { outcome: 'failed', toast: cut(`Couldn't record ${id}: ${said || `exited ${rc}`}`, TOAST_MAX) }
}

export type PageTapDeps = {
  run: Runner
  /** Answer the callback with a toast. */
  answer: (toast: string) => Promise<unknown>
  /** Replace the tapped message's keyboard. */
  editMarkup: (markup: { inline_keyboard: Button[][] }) => Promise<unknown>
  stderr: (s: string) => void
}

export type PageTap = { verb: PageTapVerb; id: string; userId: string; markup: Markup }

/**
 * Record the tap, answer it with the toast, then update the keyboard. Never
 * rejects. The answer goes before the edit so the edit cannot delay it.
 */
export async function runPageTap(deps: PageTapDeps, tap: PageTap): Promise<{ outcome: PageTapOutcome; toast: string }> {
  let r: { rc: number; stderr: string }
  try {
    r = await deps.run([INTERRUPT_BIN, 'tap', tap.verb, tap.id, '--tg-user', tap.userId], undefined, PAGE_TAP_TIMEOUT_MS)
  } catch (e) {
    r = { rc: 127, stderr: String(e) }
  }
  const res = tapResult(tap.verb, tap.id, r.rc, r.stderr)
  if (res.outcome === 'failed') deps.stderr(`page tap failed: ${tap.verb} ${tap.id} rc=${r.rc} ${r.stderr}\n`)
  try {
    await deps.answer(res.toast)
  } catch (e) {
    deps.stderr(`page tap: toast not sent: ${e}\n`)
  }
  if (res.outcome === 'done' || res.outcome === 'later' || res.outcome === 'closed') {
    try {
      await deps.editMarkup(withoutItem(tap.markup, tap.id))
    } catch (e) {
      deps.stderr(`page tap: keyboard not updated: ${e}\n`)
    }
  }
  return res
}
