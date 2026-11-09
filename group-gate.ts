/**
 * The group branch of the inbound gate, and the mention test it uses. Kept out
 * of server.ts because importing server.ts starts the bot.
 *
 * Spec item 2 (SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09): a group can
 * set requireMention per thread. A thread entry overrides the group's setting
 * for that thread only. A message in a forum's General topic carries no
 * message_thread_id, so it takes the group setting.
 */

export type ThreadPolicy = { requireMention?: boolean }

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /** Keyed by message_thread_id as a string. */
  threads?: Record<string, ThreadPolicy>
}

type Entity = { type: string; offset: number; length: number; user?: { is_bot?: boolean; username?: string } }

export type GateMessage = {
  text?: string
  caption?: string
  entities?: Entity[]
  caption_entities?: Entity[]
  message_thread_id?: number
  reply_to_message?: { from?: { username?: string } }
}

export function requireMentionFor(policy: GroupPolicy, threadId: number | undefined): boolean {
  const thread = threadId != null ? policy.threads?.[String(threadId)] : undefined
  return thread?.requireMention ?? policy.requireMention ?? true
}

export function isMentioned(
  message: GateMessage | undefined,
  botUsername: string,
  extraPatterns?: string[],
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
  if (message?.reply_to_message?.from?.username === botUsername) return true

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
): 'deliver' | 'drop' {
  if (!policy) return 'drop'
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return 'drop'
  const requireMention = requireMentionFor(policy, message?.message_thread_id)
  if (requireMention && !isMentioned(message, botUsername, mentionPatterns)) return 'drop'
  return 'deliver'
}
