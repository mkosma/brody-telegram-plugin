/**
 * The reply tool's send path: chunk the text, send each chunk, then send each
 * file. Kept out of server.ts because importing server.ts starts the bot, and
 * the send path is what the post log and the tag relay hang off.
 *
 * Everything that touches the outside world comes in through `deps`, so a test
 * can hand it a stub API and see exactly what was sent.
 */

import { statSync } from 'fs'
import { basename, extname } from 'path'
import { InputFile } from 'grammy'
import { isGroupChatId, outEntry, safeTee, type Tee } from './post-log.ts'
import type { RelayOutcome, RelayRequest } from './tag-relay.ts'
import { linkChunks, linkOptions, type HuddleLinks } from './links.ts'

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else goes as documents (raw file, no compression).
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export type ReplyAccess = {
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

type Sent = { message_id: number; entities?: Array<{ type: string; offset: number; length: number }> }

export type ReplyApi = {
  sendMessage(chat_id: string, text: string, other?: Record<string, unknown>): Promise<Sent>
  sendPhoto(chat_id: string, file: InputFile, other?: Record<string, unknown>): Promise<Sent>
  sendDocument(chat_id: string, file: InputFile, other?: Record<string, unknown>): Promise<Sent>
}

export type ReplyDeps = {
  api: ReplyApi
  loadAccess: () => ReplyAccess
  assertAllowedChat: (chat_id: string) => void
  assertSendable: (f: string) => void
  stopTyping: (chat_id: string) => void
  /** The post log. Absent means no logging; a throwing one never fails a send. */
  tee?: Tee
  /**
   * The tag relay. Called once, after the whole reply went out to a group.
   * Returns undefined when there is nothing to relay. Never awaited by the
   * reply: the outcome lands in the post log when it settles.
   */
  relay?: (req: RelayRequest) => Promise<RelayOutcome[]> | undefined
  /** Test hook: handed the background work (relay, then log) when there is some. */
  settled?: (work: Promise<void>) => void
  /**
   * huddle's published links, read once per reply (links.ts). Absent, or
   * undefined for a file that could not be read, links no items; issue
   * references are linked either way.
   */
  links?: () => Promise<HuddleLinks | undefined>
  /** Told of each text message sent, so pin_message knows this bot's own posts (pin.ts). */
  sent?: (post: { chat_id: string; thread_id: number | undefined; message_id: number; text: string }) => void
}

/** Bot API: CopyTextButton.text is 1-256 characters. */
export const COPY_TEXT_MAX = 256

/**
 * Why a copy button's text is refused, or undefined when it is fine.
 *
 * The limit of 256 is Telegram's. One line is ours (Monty, 2026-11-21,
 * Telegram msg 1855): a command handed to him is one line he can paste and
 * run. A longer script goes in a file, and the button copies the one-line
 * command that runs it.
 */
export function copyTextProblem(copy_text: unknown): string | undefined {
  const text = (copy_text as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || text.length === 0) return 'copy_text needs a text to copy'
  if (/[\r\n]/.test(text)) return 'it is more than one line'
  if (text.length > COPY_TEXT_MAX) return `it is ${text.length} characters and the limit is ${COPY_TEXT_MAX}`
  return undefined
}

// One record per message id Telegram gave back, in send order.
type SentPost = {
  message_id: number
  text: string
  reply_to?: number
  entities?: Sent['entities']
  file?: boolean
}

// Telegram caps messages at 4096 chars. Split long replies, preferring
// paragraph boundaries when chunkMode is 'newline'.

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** The links file, or undefined: a reader that throws links no items and fails no send. */
async function readLinks(links: ReplyDeps['links']): Promise<HuddleLinks | undefined> {
  try { return await links?.() } catch { return undefined }
}

export async function runReply(
  deps: ReplyDeps,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { api } = deps
  const chat_id = args.chat_id as string
  const text = args.text as string
  const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
  // Feature 1: forum topic routing
  const message_thread_id = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
  const files = (args.files as string[] | undefined) ?? []
  const format = (args.format as string | undefined) ?? 'text'
  const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined
  // Feature 3: inline keyboard
  // `style` is part of the button and must survive to the API. Leaving it
  // out of this type was half of why it never reached Telegram; the
  // keyboard construction below was the other half.
  const reply_markup = args.reply_markup as
    | { inline_keyboard: Array<Array<{ text: string; callback_data?: string; copy_text?: { text: string }; style?: 'primary' | 'success' | 'danger' }>> }
    | undefined

  deps.assertAllowedChat(chat_id)
  // A copy button is checked before anything is sent, so a bad one fails the
  // whole reply with its reason and never arrives as a button that copies nothing.
  for (const btn of (reply_markup?.inline_keyboard ?? []).flat()) {
    if (btn?.copy_text === undefined) continue
    const problem = copyTextProblem(btn.copy_text)
    if (problem) throw new Error(`copy button "${btn.text}" refused: ${problem}. A copy button copies one line of at most ${COPY_TEXT_MAX} characters; put a longer script in a file and copy the command that runs it.`)
  }
  // The reply is going out now: stop the "is composing" typing keepalive.
  deps.stopTyping(chat_id)

  for (const f of files) {
    deps.assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const access = deps.loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  const replyMode = access.replyToMode ?? 'first'
  const chunks = chunk(text, limit, mode)
  // His items and issue references become links here (links.ts). The log, the
  // relay and the pin record keep the text the agent wrote.
  const linked = linkChunks(text, chunks, await readLinks(deps.links), parseMode !== undefined, MAX_CHUNK_LIMIT)
  const sentIds: number[] = []
  const posts: SentPost[] = []

  // Feature 3: pass the caller's inline keyboard THROUGH, unrebuilt.
  // Only attach to the first chunk; subsequent chunks are overflow text.
  //
  // THIS USED TO CALL grammyKeyboard.text(btn.text, btn.callback_data),
  // which takes exactly two arguments and therefore DROPPED `style` by
  // construction. Every styled button the fleet has ever sent arrived
  // uncolored because of this line, and two previous attempts to fix the
  // problem never looked at it: one blamed the caller's schema validation
  // (1fb9acd) and one blamed the client being too old. Both were wrong.
  //
  // Settled 2026-09-03 by posting the same four buttons twice, once
  // straight to the Bot API and once through here. The API set came back
  // blue, green and red; ours came back plain. So the API stores `style`,
  // Monty's client renders it, and this function was the only thing
  // standing between them.
  //
  // Building the markup as a plain object instead of via the InlineKeyboard
  // builder keeps every field the caller sent, including ones added to the
  // Bot API after this code was written. A builder that enumerates the
  // fields it knows will silently drop the next one too.
  const grammyKeyboard = reply_markup?.inline_keyboard
    ? { inline_keyboard: reply_markup.inline_keyboard.map(row => row.map(btn => ({ ...btn }))) }
    : undefined

  // Log whatever actually went out, including the chunks sent before a
  // failure: those are in the chat whether or not the reply as a whole failed.
  const sendAll = async (): Promise<void> => {
    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo =
          reply_to != null &&
          replyMode !== 'off' &&
          (replyMode === 'all' || i === 0)
        // Attach keyboard only to the first (or only) chunk.
        const chunkKeyboard = i === 0 ? grammyKeyboard : undefined
        const sent = await api.sendMessage(chat_id, linked[i].text, {
          ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...linkOptions(linked[i]),
          ...(message_thread_id != null ? { message_thread_id } : {}),
          ...(chunkKeyboard ? { reply_markup: chunkKeyboard } : {}),
        })
        sentIds.push(sent.message_id)
        try { deps.sent?.({ chat_id, thread_id: message_thread_id, message_id: sent.message_id, text: chunks[i] }) } catch {}
        posts.push({
          message_id: sent.message_id,
          text: chunks[i],
          entities: sent.entities,
          ...(shouldReplyTo ? { reply_to } : {}),
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
      )
    }

    // Files go as separate messages (Telegram doesn't mix text+file in one
    // sendMessage call). Thread under reply_to and/or topic if present.
    for (const f of files) {
      const ext = extname(f).toLowerCase()
      const input = new InputFile(f)
      const opts = {
        ...(reply_to != null && replyMode !== 'off'
          ? { reply_parameters: { message_id: reply_to } }
          : {}),
        ...(message_thread_id != null ? { message_thread_id } : {}),
      }
      const fileReplyTo = reply_to != null && replyMode !== 'off' ? { reply_to } : {}
      if (PHOTO_EXTS.has(ext)) {
        const sent = await api.sendPhoto(chat_id, input, Object.keys(opts).length ? opts : undefined)
        sentIds.push(sent.message_id)
        posts.push({ message_id: sent.message_id, text: `(photo: ${basename(f)})`, file: true, ...fileReplyTo })
      } else {
        const sent = await api.sendDocument(chat_id, input, Object.keys(opts).length ? opts : undefined)
        sentIds.push(sent.message_id)
        posts.push({ message_id: sent.message_id, text: `(document: ${basename(f)})`, file: true, ...fileReplyTo })
      }
    }
  }

  let ok = false
  try {
    await sendAll()
    ok = true
  } finally {
    if (isGroupChatId(chat_id)) {
      const entries = posts.map(p => outEntry({
        chat_id, thread_id: message_thread_id, message_id: p.message_id, reply_to: p.reply_to, text: p.text, edit: false,
      }))
      const writeAll = () => { for (const e of entries) safeTee(deps.tee, e) }
      // Relay only a reply that went out whole, and only its text.
      let relaying: Promise<RelayOutcome[]> | undefined
      if (ok && deps.relay) {
        try {
          relaying = deps.relay({ chat_id, thread_id: message_thread_id, posts: posts.filter(p => !p.file) })
        } catch (err) {
          process.stderr.write(`telegram channel: tag relay failed to start: ${err}\n`)
        }
      }
      if (!relaying) {
        writeAll()
      } else {
        // The outcome rides the post's first line: relayed: [{to, rc}].
        const work = relaying.then(
          outcomes => { if (entries[0]) entries[0].relayed = outcomes },
          err => { if (entries[0]) entries[0].relayed = [{ error: String(err) }] },
        ).finally(writeAll)
        deps.settled?.(work)
      }
    }
  }

  const result =
    sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
  return { content: [{ type: 'text', text: result }] }
}

export type ReactApi = {
  setMessageReaction(chat_id: string, message_id: number, reaction: Array<{ type: 'emoji'; emoji: string }>): Promise<true>
}

/** The react tool. Gated like every outbound tool: never into a private chat (private-chat.ts). */
export async function runReact(
  deps: { api: ReactApi; assertAllowedChat: (chat_id: string) => void },
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const chat_id = args.chat_id as string
  deps.assertAllowedChat(chat_id)
  await deps.api.setMessageReaction(chat_id, Number(args.message_id), [
    { type: 'emoji', emoji: args.emoji as string },
  ])
  return { content: [{ type: 'text', text: 'reacted' }] }
}

export type EditApi = {
  editMessageText(
    chat_id: string,
    message_id: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<true | { message_id: number; message_thread_id?: number; reply_to_message?: { message_id: number } }>
}

export async function runEditMessage(
  deps: { api: EditApi; assertAllowedChat: (chat_id: string) => void; tee?: Tee; links?: ReplyDeps['links'] },
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const chat_id = args.chat_id as string
  deps.assertAllowedChat(chat_id)
  const editFormat = (args.format as string | undefined) ?? 'text'
  const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
  // Linked as a reply is (links.ts). The log keeps the text the agent wrote.
  const text = args.text as string
  const [linked] = linkChunks(text, [text], await readLinks(deps.links), editParseMode !== undefined, MAX_CHUNK_LIMIT)
  const other = { ...(editParseMode ? { parse_mode: editParseMode } : {}), ...linkOptions(linked) }
  const edited = await deps.api.editMessageText(
    chat_id,
    Number(args.message_id),
    linked.text,
    ...(Object.keys(other).length ? [other] : []),
  )
  const id = typeof edited === 'object' ? edited.message_id : args.message_id
  if (isGroupChatId(chat_id)) {
    const msg = typeof edited === 'object' ? edited : undefined
    safeTee(deps.tee, outEntry({
      chat_id,
      thread_id: msg?.message_thread_id,
      message_id: Number(id),
      reply_to: msg?.reply_to_message?.message_id,
      text: args.text as string,
      edit: true,
    }))
  }
  return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
}
