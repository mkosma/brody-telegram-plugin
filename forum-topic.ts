/**
 * edit_forum_topic: rename a forum topic. Spec item 4
 * (SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09). Kept out of server.ts
 * because importing server.ts starts the bot.
 *
 * Telegram allows it only from a bot that is an admin with can_manage_topics
 * (today, Vera's), so most bots will get an error back. That error is the
 * API's own description, returned as is: it says which right is missing,
 * which nothing here could say better.
 *
 * create_forum_topic: SPEC-bridge-presence-by-invite-2026-11-19, amendment A.
 * A new topic has no thread entry, so under presence by invite no bot would
 * be present in it, not even the one that made it. Monty's ruling: "the
 * default should be only the creator ... and whatever bots I tell you to
 * add." So the creating bridge invites itself: runGroupCommand, the code
 * /invite runs, writes this bot's own thread entry `requireMention:false`.
 * It posts no arrival phrase and sends the session no invite event, since
 * the tool result already tells the agent. No other bot's access is touched;
 * the others join by /invite or by Monty's mention.
 */

import { threadKey } from './group-gate.ts'
import { runGroupCommand, type CommandAccess, type CommandDeps } from './invite-excuse.ts'

export type ForumTopicApi = {
  editForumTopic(chat_id: string, message_thread_id: number, other: { name: string }): Promise<true>
}

export type CreateForumTopicApi = {
  createForumTopic(chat_id: string, name: string): Promise<{ message_thread_id: number; name: string }>
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/**
 * Create the topic, then make this bot present in it. An API error is thrown
 * to the caller as before, with nothing written. Once the topic exists the
 * result is never an error: when the entry could not be written (a static
 * bridge, a failed access.json write) the text says the bot is not present.
 */
export async function runCreateForumTopic<A extends CommandAccess>(
  deps: { api: CreateForumTopicApi; assertAllowedChat: (chat_id: string) => void } & Pick<CommandDeps<A>, 'isStatic' | 'loadAccess' | 'saveAccess' | 'stderr'>,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const chat_id = args.chat_id as string
  deps.assertAllowedChat(chat_id)
  const topic = await deps.api.createForumTopic(chat_id, args.name as string)
  const thread = topic.message_thread_id
  // quiet: nothing is posted. notify is a no-op: the tool result tells the agent.
  const present = await runGroupCommand<A>(
    { ...deps, agent: '', botUsername: () => '', phrase: () => '', answer: async () => { throw new Error('create_forum_topic posts nothing') }, notify: () => {} },
    { kind: 'act', verb: 'invite', chat_id, thread_id: thread, key: threadKey(thread), quiet: true },
  )
  const absent = present === 'static' ? 'access is static' : present === 'failed' ? 'the access.json write failed' : undefined
  return {
    content: [{
      type: 'text',
      text: `created topic "${topic.name}" (message_thread_id: ${thread})`
        + (absent ? `. This bot is NOT present in it (${absent}): it hears only mentions there until Monty invites it.` : ''),
    }],
  }
}

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
