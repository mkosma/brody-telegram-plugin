/**
 * Button state: after Monty taps a button the bridge serves, the message's
 * keyboard shows what he chose.
 *
 * Monty, 2026-11-21 (Now Playing topic 532, Telegram msg 1855, relayed by
 * Maya). Design: Grady. A tap used to leave the keyboard exactly as it was,
 * so nothing in scrollback said which button had been pressed, or that any
 * had.
 *
 * A CHOICE IS FROZEN. The chosen button becomes "✓ <label>" and the others
 * are removed. A change of mind is a new message. The frozen button carries
 * FROZEN_DATA, so a second tap is answered with a toast and reaches no agent
 * and no command.
 *
 * A TAP THAT SHOWS OR OPENS SOMETHING IS MARKED, NOT FROZEN (SHOW_AND_KEEP).
 * An open button is not a choice between the buttons beside it: a message
 * citing three documents carries three, and an alert's "Show fix" sits beside
 * the Ignore and Snooze he has yet to pick. Removing the others there would
 * take away buttons he still needs. So that button gains the "✓ " and every
 * button stays, working. This narrows the design as written, which freezes
 * every tap; to freeze these too, empty SHOW_AND_KEEP.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

export const CHECK = '✓ '
/** callback_data of a frozen button. Not a prefix any handler serves. */
export const FROZEN_DATA = 'fz'

/** Taps that show or open something: omf: and open: documents, an alert's Show fix. */
export const SHOW_AND_KEEP: RegExp[] = [/^omf:/, /^open:/, /^al:fx:/]

export function showsOrOpens(data: string): boolean {
  return SHOW_AND_KEEP.some(re => re.test(data))
}

type Button = { text?: string; callback_data?: string; [k: string]: unknown }
export type Markup = { inline_keyboard?: Button[][] } | undefined

const marked = (text: string | undefined) => (text?.startsWith(CHECK) ? text : `${CHECK}${text ?? ''}`)

/**
 * The keyboard after a tap on the button carrying `data`, or undefined when
 * there is nothing to change: no keyboard, no such button, or a show button
 * already marked. Every other field of the button (its style) is kept.
 */
export function chosenKeyboard(markup: Markup, data: string, keepOthers: boolean): { inline_keyboard: Button[][] } | undefined {
  const rows = markup?.inline_keyboard
  if (!rows) return undefined
  const tapped = rows.flat().find(b => b?.callback_data === data)
  if (!tapped) return undefined
  if (keepOthers) {
    if (tapped.text?.startsWith(CHECK)) return undefined
    return { inline_keyboard: rows.map(row => row.map(b => (b === tapped ? { ...b, text: marked(b.text) } : { ...b }))) }
  }
  return { inline_keyboard: [[{ ...tapped, text: marked(tapped.text), callback_data: FROZEN_DATA }]] }
}

export type MarkDeps = {
  /** editMessageReplyMarkup on the tapped message. */
  edit: (markup: { inline_keyboard: Button[][] }) => Promise<unknown>
  stderr: (s: string) => void
}

/** Edit the tapped message's keyboard to show the tap. Never rejects. */
export async function markTapped(deps: MarkDeps, markup: Markup, data: string): Promise<'frozen' | 'marked' | 'unchanged' | 'failed'> {
  const keep = showsOrOpens(data)
  const next = chosenKeyboard(markup, data, keep)
  if (!next) return 'unchanged'
  try {
    await deps.edit(next)
    return keep ? 'marked' : 'frozen'
  } catch (e) {
    deps.stderr(`button state: keyboard edit failed: ${e}\n`)
    return 'failed'
  }
}

/** The toast for a second tap on a frozen button. */
export function frozenToast(markup: Markup): string {
  const label = (markup?.inline_keyboard ?? []).flat().find(b => b?.callback_data === FROZEN_DATA)?.text
  const said = label ? `Already chosen: ${label.startsWith(CHECK) ? label.slice(CHECK.length) : label}` : 'Already chosen.'
  return said.length <= 200 ? said : `${Array.from(said).slice(0, 199).join('')}…`
}
