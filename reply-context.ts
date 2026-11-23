/**
 * Reply context: which message an inbound post replies to.
 *
 * WHY. Monty replied to a message of Werner's and Werner could not tell which
 * (2026-11-23). The update carries `reply_to_message` and the post log records
 * its id, but the event handed to the agent carried nothing, so a reply read
 * as a post from nowhere. Grady's brief of 2026-11-23, class 2 batch 2, item 2.
 *
 * Three attributes, on text and media posts alike, and only on a real reply:
 *   reply_to       the replied-to message's id
 *   reply_to_text  its text or caption: one line, at most REPLY_TEXT_MAX chars
 *   reply_to_from  its author's username, or first name when it has none
 *
 * A POST IN A FORUM TOPIC IS NOT A REPLY. Telegram sets `reply_to_message` on
 * every post in a topic to the service message that created the topic, whose
 * id is the thread id. Reporting that would mark every topic post a reply, so
 * it is left out.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

export const REPLY_TEXT_MAX = 300

export type RepliedMessage = {
  message_id?: number
  text?: string
  caption?: string
  from?: { username?: string; first_name?: string }
  forum_topic_created?: unknown
}

export type ReplyingMessage = {
  message_thread_id?: number
  reply_to_message?: RepliedMessage
}

export type ReplyContext = { reply_to?: string; reply_to_text?: string; reply_to_from?: string }

/** One line that cannot close the attribute it sits in or open a tag. */
function attr(v: string, max: number): string {
  const flat = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/"/g, "'").replace(/[<>]/g, '_')
  return Array.from(flat).slice(0, max).join('')
}

export function replyContext(msg: ReplyingMessage | undefined): ReplyContext {
  const r = msg?.reply_to_message
  if (!r || r.message_id == null) return {}
  if (r.forum_topic_created != null || r.message_id === msg?.message_thread_id) return {}
  const out: ReplyContext = { reply_to: String(r.message_id) }
  const text = attr(r.text ?? r.caption ?? '', REPLY_TEXT_MAX)
  if (text) out.reply_to_text = text
  const from = attr(r.from?.username ?? r.from?.first_name ?? '', 64)
  if (from) out.reply_to_from = from
  return out
}
