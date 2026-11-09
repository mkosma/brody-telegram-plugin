/**
 * The pure half of the bridge's inbound decisions: what gate() decides, what
 * text a message is logged under, which updates are polled, and how the
 * channel .env is read. Kept out of server.ts because importing server.ts
 * starts the bot, and shared with wake-check.ts, which must decide exactly as
 * the bridge would without being the bridge
 * (SPEC-on-call-agents-wake-and-sleep-2026-11-09, "The wake check").
 *
 * Nothing here writes anything. gate()'s side effects (pruning expired
 * pairings, issuing a pairing code) stay in server.ts.
 */

import { groupDecision, type GateMessage, type GroupPolicy } from './group-gate.ts'

/** The update kinds the bridge polls for. Passed to getUpdates by bot.start() and by the wake check. */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'message_reaction',
  'message_reaction_count',
] as const

export type GateAccess = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  mentionPatterns?: string[]
}

export type InboundDecision = 'deliver' | 'drop' | 'pair'

/**
 * gate()'s decision, without its side effects. 'pair' means a DM from a
 * stranger under dmPolicy "pairing": gate() then issues or re-sends a code, or
 * drops it when the pending cap is reached. Nothing is delivered to the
 * session either way.
 */
export function inboundDecision(
  access: GateAccess,
  p: {
    from?: { id: number }
    chat?: { id: number | string; type?: string }
    message?: GateMessage
  },
  botUsername: string,
  agent: string,
): InboundDecision {
  if (access.dmPolicy === 'disabled') return 'drop'

  const from = p.from
  if (!from) return 'drop'
  const senderId = String(from.id)
  const chatType = p.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return 'deliver'
    if (access.dmPolicy === 'allowlist') return 'drop'
    return 'pair'
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    // requireMention can be set per thread (groups[id].threads[thread_id]);
    // see group-gate.ts. access.json is re-read on every message.
    const policy = access.groups[String(p.chat!.id)]
    return groupDecision(policy, senderId, p.message, botUsername, access.mentionPatterns, agent)
  }

  return 'drop'
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification, where delimiter chars would let the uploader break out of the
// tag or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

export type InboundMedia = {
  text?: string
  caption?: string
  photo?: unknown[]
  document?: { file_name?: string }
  voice?: unknown
  audio?: { file_name?: string; title?: string }
  video?: unknown
  video_note?: unknown
  sticker?: { emoji?: string }
}

/**
 * The text a message reaches handleInbound with, which is the text the post
 * log records. undefined for a message kind the bridge has no handler for:
 * the bridge neither delivers nor logs one of those.
 */
export function inboundText(m: InboundMedia): string | undefined {
  if (m.text != null) return m.text
  if (m.photo) return m.caption ?? '(photo)'
  if (m.document) return m.caption ?? `(document: ${safeName(m.document.file_name) ?? 'file'})`
  if (m.voice) return m.caption ?? '(voice message)'
  if (m.audio) return m.caption ?? `(audio: ${safeName(m.audio.title) ?? safeName(m.audio.file_name) ?? 'audio'})`
  if (m.video) return m.caption ?? '(video)'
  if (m.video_note) return '(video note)'
  if (m.sticker) return `(sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''})`
  return undefined
}

/**
 * The channel .env, as KEY=VALUE lines. The first occurrence of a key wins,
 * which is what server.ts's "real env wins" loop has always done.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && !(m[1] in out)) out[m[1]] = m[2]
  }
  return out
}
