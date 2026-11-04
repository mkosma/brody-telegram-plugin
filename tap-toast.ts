/**
 * The toast shown when Monty taps a generic inline button, the one that hands
 * the tap to the agent's session as a channel event.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 *
 * "Sent" is the strongest word the bridge can honestly use. A resolved
 * mcp.notification() means the event was written to the session's channel,
 * not that the model has seen it: a busy session takes it on its next turn.
 */

export type TapOutcome = 'resolved' | 'rejected' | 'timeout'

type Button = { text?: string; callback_data?: string }
type ReplyMarkup = { inline_keyboard?: Button[][] } | undefined

// Bot API limit on answerCallbackQuery text.
export const TOAST_MAX = 200

export function tapToast(
  outcome: TapOutcome,
  agent: string,
  data: string,
  replyMarkup: ReplyMarkup,
): string {
  // ACCESS_AGENT is the literal '<Agent>' when the name could not be verified.
  // Never guess a name.
  const who = agent === '<Agent>' ? 'this session' : agent

  if (outcome === 'rejected') return `⚠ Not delivered: ${who} is not listening`.slice(0, TOAST_MAX)

  const head = outcome === 'resolved' ? `✓ Sent to ${who}` : `… Sending to ${who}`
  // The label is the button's own text. Without one, say nothing more rather
  // than show the raw callback data.
  const label = (replyMarkup?.inline_keyboard ?? []).flat().find(b => b?.callback_data === data)?.text
  if (!label) return head.slice(0, TOAST_MAX)

  const full = `${head}: ${label}`
  if (full.length <= TOAST_MAX) return full

  // Cut the label, by code point so an emoji is never split, until the toast
  // plus the ellipsis fits.
  const room = TOAST_MAX - head.length - ': '.length - '…'.length
  let cut = ''
  for (const ch of Array.from(label)) {
    if (cut.length + ch.length > room) break
    cut += ch
  }
  return `${head}: ${cut}…`
}
