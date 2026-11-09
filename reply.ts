/**
 * The reply tool's send path: chunk the text, send each chunk, then send each
 * file. Kept out of server.ts because importing server.ts starts the bot, and
 * the send path is what the post log and the tag relay hang off.
 *
 * Everything that touches the outside world comes in through `deps`, so a test
 * can hand it a stub API and see exactly what was sent.
 */

import { statSync } from 'fs'
import { extname } from 'path'
import { InputFile } from 'grammy'

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

type Sent = { message_id: number }

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
    | { inline_keyboard: Array<Array<{ text: string; callback_data: string; style?: 'primary' | 'success' | 'danger' }>> }
    | undefined

  deps.assertAllowedChat(chat_id)
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
  const sentIds: number[] = []

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

  try {
    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo =
        reply_to != null &&
        replyMode !== 'off' &&
        (replyMode === 'all' || i === 0)
      // Attach keyboard only to the first (or only) chunk.
      const chunkKeyboard = i === 0 ? grammyKeyboard : undefined
      const sent = await api.sendMessage(chat_id, chunks[i], {
        ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(message_thread_id != null ? { message_thread_id } : {}),
        ...(chunkKeyboard ? { reply_markup: chunkKeyboard } : {}),
      })
      sentIds.push(sent.message_id)
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
    if (PHOTO_EXTS.has(ext)) {
      const sent = await api.sendPhoto(chat_id, input, Object.keys(opts).length ? opts : undefined)
      sentIds.push(sent.message_id)
    } else {
      const sent = await api.sendDocument(chat_id, input, Object.keys(opts).length ? opts : undefined)
      sentIds.push(sent.message_id)
    }
  }

  const result =
    sentIds.length === 1
      ? `sent (id: ${sentIds[0]})`
      : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
  return { content: [{ type: 'text', text: result }] }
}
