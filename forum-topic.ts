/**
 * edit_forum_topic: rename a forum topic. Spec item 4
 * (SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09). Kept out of server.ts
 * because importing server.ts starts the bot.
 *
 * Telegram allows it only from a bot that is an admin with can_manage_topics
 * (today, Vera's), so most bots will get an error back. That error is the
 * API's own description, returned as is: it says which right is missing,
 * which nothing here could say better.
 */

export type ForumTopicApi = {
  editForumTopic(chat_id: string, message_thread_id: number, other: { name: string }): Promise<true>
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export async function runEditForumTopic(
  deps: { api: ForumTopicApi; assertAllowedChat: (chat_id: string) => void },
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const chat_id = args.chat_id as string
  const thread = Number(args.message_thread_id)
  const name = args.name as string
  deps.assertAllowedChat(chat_id)
  if (!Number.isInteger(thread) || thread <= 0) {
    return { content: [{ type: 'text', text: `edit_forum_topic failed: message_thread_id must be a positive integer, got ${String(args.message_thread_id)}` }], isError: true }
  }
  try {
    await deps.api.editForumTopic(chat_id, thread, { name })
  } catch (err) {
    // GrammyError carries Telegram's own text in .description.
    const desc = (err as { description?: string }).description ?? (err instanceof Error ? err.message : String(err))
    return { content: [{ type: 'text', text: `edit_forum_topic failed: ${desc}` }], isError: true }
  }
  return { content: [{ type: 'text', text: `renamed topic ${thread} to "${name}"` }] }
}
