/**
 * The group branch of the inbound gate, and the mention test it uses. Kept out
 * of server.ts because importing server.ts starts the bot.
 *
 * Spec item 2 (SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09): a group can
 * set requireMention per thread. A thread entry overrides the group's setting
 * for that thread only. A message in a forum's General topic carries no
 * message_thread_id; it takes the "general" thread entry when there is one
 * (SPEC-bridge-names-invite-excuse-2026-11-09 item 2), else the group setting.
 *
 * SPEC-bridge-names-invite-excuse-2026-11-09, item 1: `@<name>` for this
 * bridge's agent counts as a mention with no configuration.
 *
 * SPEC-bridge-presence-by-invite-2026-11-19, item 1: in a forum (a chat whose
 * `is_forum` is true) presence is the thread entry and nothing else. A thread
 * with `requireMention:false` is present and hears every post. A thread with
 * no entry, or with `requireMention:true`, is absent and hears only a
 * mention, whatever the group's own setting says. A group that is not a forum
 * has no topics to be invited to, and decides as before.
 */

export type ThreadPolicy = { requireMention?: boolean }

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /** Keyed by message_thread_id as a string, or "general" for the General topic. */
  threads?: Record<string, ThreadPolicy>
}

type Entity = { type: string; offset: number; length: number; user?: { is_bot?: boolean; username?: string } }

export type GateMessage = {
  text?: string
  caption?: string
  entities?: Entity[]
  caption_entities?: Entity[]
  message_thread_id?: number
  reply_to_message?: { message_id?: number; forum_topic_created?: unknown; from?: { username?: string } }
}

/**
 * The key a thread's entry is stored under: its message_thread_id, or
 * "general" for a post with none (a forum's General topic). Without the
 * "general" key an /invite there could only be written to the group setting,
 * which would open every topic.
 */
export function threadKey(threadId: number | undefined): string {
  return threadId != null ? String(threadId) : 'general'
}

export function requireMentionFor(policy: GroupPolicy, threadId: number | undefined, isForum = false): boolean {
  const thread = policy.threads?.[threadKey(threadId)]
  if (isForum) return thread?.requireMention !== false
  return thread?.requireMention ?? policy.requireMention ?? true
}

/**
 * The built-in mention for this bridge's agent: `@vera`, `@Vera,` and
 * `hi @vera` match; `@verabot`, `x@vera.com` and `@veranda` do not. An
 * unverified name ('<Agent>', or none) has no pattern, so it can never match.
 */
export function nameMentionPattern(agent: string | undefined): RegExp | undefined {
  if (!agent || !/^[A-Za-z][A-Za-z0-9]*$/.test(agent)) return undefined
  return new RegExp(`(^|[^\\w@])@${agent}(?![\\w])`, 'i')
}

/**
 * In a forum every plain post in a topic carries reply_to_message = the topic
 * root (the forum_topic_created service message, whose message_id is the
 * topic's message_thread_id). That is the client filing the post, not the
 * sender replying to anyone, so it is no mention: in a topic this bot created
 * the root is the bot's own message, and counting it would make every post
 * there a mention and no /excuse could stick.
 */
export function repliesToTopicRoot(message: GateMessage | undefined): boolean {
  const reply = message?.reply_to_message
  if (!reply) return false
  if (reply.forum_topic_created != null) return true
  return reply.message_id != null && reply.message_id === message?.message_thread_id
}

export function isMentioned(
  message: GateMessage | undefined,
  botUsername: string,
  extraPatterns?: string[],
  agent?: string,
): boolean {
  const entities = message?.entities ?? message?.caption_entities ?? []
  const text = message?.text ?? message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }

  // Reply to one of our messages counts as an implicit mention.
  if (!repliesToTopicRoot(message) && message?.reply_to_message?.from?.username === botUsername) return true

  if (nameMentionPattern(agent)?.test(text)) return true

  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // Invalid user-supplied regex: skip it.
    }
  }
  return false
}

export function groupDecision(
  policy: GroupPolicy | undefined,
  senderId: string,
  message: GateMessage | undefined,
  botUsername: string,
  mentionPatterns?: string[],
  agent?: string,
  isForum = false,
): 'deliver' | 'drop' {
  if (!policy) return 'drop'
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return 'drop'
  const requireMention = requireMentionFor(policy, message?.message_thread_id, isForum)
  if (requireMention && !isMentioned(message, botUsername, mentionPatterns, agent)) return 'drop'
  return 'deliver'
}
