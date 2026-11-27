/**
 * The bridge's outbound rules, in one file, because one file is what the
 * server can re-read without a restart.
 *
 * Design: agents/Grady/design/DESIGN-bridge-hot-reloads-outbound-rules-2026-11-27.
 *
 * server.ts does not import this file. It loads it through outbound-loader.ts,
 * which looks at this file's mtime and size before each tool call and imports
 * it again when either changed. So a change here is live at deploy, and a
 * change to anything this file imports (post-log.ts, tag-relay.ts, grammy)
 * still waits for a restart: an import of this file re-reads this file only.
 * That is why the three parts below are here and not in files of their own.
 *
 *   1. THE PRIVATE-CHAT GATE   no post into a private chat but a named exemption
 *   2. REFERENCE LINKS         his items and issue references become links
 *   3. THE SEND PATH           reply, react and edit_message: the format, the
 *                              chunks, the copy-button check
 *
 * The server calls the functions named in OUTBOUND_EXPORTS (outbound-loader.ts).
 * A version of this file that lacks one of them is not loaded, and the last
 * good version keeps sending.
 */

import { statSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, extname, join } from 'path'
import { InputFile } from 'grammy'
import { isGroupChatId, outEntry, safeTee, type Tee } from './post-log.ts'
import type { RelayOutcome, RelayRequest } from './tag-relay.ts'

// --- 1. THE PRIVATE-CHAT GATE ---------------------------------------------------------

/**
 * The bridge refuses a post into a private chat.
 *
 * Design: agents/Grady/design/DESIGN-bridge-refuses-bot-dms-2026-11-27.
 *
 * WHAT WAS SO. assertAllowedChat passed any chat in allowFrom. Monty's user id
 * is in it for his inbound DMs, and a private chat's id equals the user id, so
 * every agent bot could reply, edit or react in his DM and nothing refused it.
 * Maya's Shortcut replies landed in an archived DM that way and returned
 * success to her.
 *
 * TWO LAYERS, ONE RULE.
 *   1. assertOutboundChat is the outbound tools' gate. A tool handed a private
 *      chat fails at once with PRIVATE_CHAT_REFUSAL, before anything is sent,
 *      so the agent reads where the post belongs.
 *   2. refusePrivateChat is a transformer on the bot's API. It sees every call
 *      the bridge makes, so a send path nobody thought to gate is refused by
 *      default rather than allowed by default.
 *
 * EXEMPTIONS ARE NAMED HERE AND NOWHERE ELSE. A path of the bridge's own that
 * must keep posting into a private chat is one row of PRIVATE_CHAT_EXEMPTIONS,
 * with its reason and the API methods it covers, and its call site marks the
 * payload with exempt('<name>'). The mark is a symbol key: tool arguments
 * arrive as JSON, which cannot carry one, so there is no override an agent can
 * pass.
 *
 * INBOUND IS UNTOUCHED. He can still message a bot directly; the bot answers
 * in the FLEET topic where the work is.
 */

/** The tool's error, word for word from the design: it names the home. */
export const PRIVATE_CHAT_REFUSAL = "Monty's DM is not a work channel: post in the FLEET topic where the work is."

/**
 * Telegram chat ids: a user (so a DM) is positive, a group or supergroup is
 * negative. A private chat's id is the user's id.
 */
export function isPrivateChatId(chat_id: unknown): boolean {
  return (typeof chat_id === 'string' || typeof chat_id === 'number') && /^[1-9]\d*$/.test(String(chat_id))
}

/**
 * Every path that may still post into a private chat, by name. To add one,
 * add a row with its reason; there is no other way through.
 */
export const PRIVATE_CHAT_EXEMPTIONS = {
  pairing: {
    reason: 'A stranger being paired has no FLEET topic: the pairing code and the "Paired!" confirmation can only go to the DM the request came from.',
    methods: ['sendMessage'],
  },
  'dm-command': {
    reason: '/start, /help and /status are answered only in a DM, because a group answer would show a pairing code to the group. They say how pairing stands and carry no work.',
    methods: ['sendMessage'],
  },
  'permission-relay': {
    reason: 'A Claude Code permission prompt goes only to a paired DM, because Allow and Deny are his alone and a group member was never paired. Covers the prompt, the edit that records his choice and the mark on his typed yes or no.',
    methods: ['sendMessage', 'editMessageText', 'setMessageReaction'],
  },
  'tap-answer': {
    reason: "The bridge's answer to a button he tapped goes on or under the tapped message: the mark on the tapped button, and the one line that says an open or an alert action failed. A button already standing in a DM must not fail silently.",
    methods: ['sendMessage', 'editMessageReplyMarkup'],
  },
  'pin-release': {
    reason: 'Taking a pin down posts nothing, and a pin placed in a DM before this refusal existed must still come down.',
    methods: ['unpinChatMessage'],
  },
  'wake-ack': {
    reason: 'wake-check answers his DM to a sleeping agent where he sent it, as SPEC-on-call-agents-wake-and-sleep-2026-11-09 has it. Dormant while FLEET_ONCALL is empty.',
    methods: ['sendMessage'],
  },
} as const satisfies Record<string, { reason: string; methods: readonly string[] }>

export type PrivateChatExemption = keyof typeof PRIVATE_CHAT_EXEMPTIONS

const EXEMPT = Symbol('private-chat-exemption')

/**
 * Spread into a call's `other` to mark it as one of the named exemptions:
 * `bot.api.sendMessage(id, text, exempt('pairing'))`.
 */
export function exempt(name: PrivateChatExemption): Record<never, never> {
  return { [EXEMPT]: name }
}

function exemptionCovers(name: unknown, method: string): boolean {
  if (typeof name !== 'string' || !Object.hasOwn(PRIVATE_CHAT_EXEMPTIONS, name)) return false
  return (PRIVATE_CHAT_EXEMPTIONS[name as PrivateChatExemption].methods as readonly string[]).includes(method)
}

/**
 * The transformer. Any call that carries a private chat_id is refused unless
 * it is a read (get*: it posts nothing) or its payload is marked with an
 * exemption that covers the method.
 */
export async function refusePrivateChat<T>(
  prev: (method: never, payload: never, signal?: AbortSignal) => Promise<T>,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const p = (payload ?? {}) as Record<PropertyKey, unknown>
  if (isPrivateChatId(p.chat_id) && !method.startsWith('get') && !exemptionCovers(p[EXEMPT], method)) {
    throw new Error(`${PRIVATE_CHAT_REFUSAL} (${method} to a private chat refused by the bridge)`)
  }
  return prev(method as never, payload as never, signal)
}

export type OutboundAccess = { allowFrom: string[]; groups: Record<string, unknown> }

/**
 * The outbound tools' gate. A private chat is refused first, allowlisted or
 * not: allowlisting a user lets his DMs in, it never made his DM a place to
 * post. Then the chat must be a group the inbound gate would deliver from.
 *
 * `exemption` is for a tool that is itself a named exemption (unpin_message);
 * it is fixed where the tool is wired, never read from the tool's arguments.
 */
export function assertOutboundChat(
  access: OutboundAccess,
  chat_id: string,
  accessCmd: string,
  exemption?: PrivateChatExemption,
): void {
  if (isPrivateChatId(chat_id)) {
    if (exemption === undefined || !Object.hasOwn(PRIVATE_CHAT_EXEMPTIONS, exemption)) throw new Error(PRIVATE_CHAT_REFUSAL)
    if (access.allowFrom.includes(chat_id)) return
  }
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted: add it with ${accessCmd} group-add <chat_id>`)
}

// --- 2. REFERENCE LINKS ---------------------------------------------------------------

/**
 * The bridge links every item and issue reference.
 *
 * Design: agents/Grady/design/DESIGN-bridge-links-references-2026-11-27
 * (approved by Monty, FLEET 40 msg 4008).
 *
 * WHAT WAS SO. Agents name his numbered items ("47", "item 47") and GitHub
 * issues in plain text, unlinked. A hook cannot rewrite a message under auto
 * mode, so the linking is here, where the Telegram call is built: reply and
 * edit_message, any chat, before the text is chunked.
 *
 * ITEMS. `#47`, `item 47`, `on 47`, and a message or line that opens `47 is`,
 * `47:` or `47,` link to item 47's message, only when 47 is in the links file
 * and open there. `huddle` writes that file (monty-ops shell/bin/huddle, "THE
 * LINKS FILE"); the bridge never computes a link from the stores. A missing or
 * unreadable file links no items and the message is sent anyway.
 *
 * ISSUES. `agents#123`, `monty-ops#123`, `deck#123` and `owner/repo#123` link
 * to that GitHub issue. The short names are ISSUE_REPOS and nowhere else.
 *
 * NEVER inside a code span, a code block, an existing link or a URL.
 *
 * TWO RENDERINGS. A plain-text message keeps its text and gains `text_link`
 * entities, so nothing needs escaping. A MarkdownV2 message has each reference
 * wrapped as `[ref](url)`: the reference is the agent's own text, already
 * escaped, and the URL has its `)` and `\` escaped.
 */

/** The one table of short repo names. */
export const ISSUE_REPOS: Record<string, string> = {
  agents: 'mkosma/agents',
  'monty-ops': 'mkosma/monty-ops',
  deck: 'chironic/chironic-deck',
}

/** What huddle publishes: {"47": {"link": "https://t.me/c/...", "open": true}}. */
export type HuddleLinks = Record<string, { link: string; open: boolean }>

/**
 * The links file is on maxi. $MAXI is the fleet's handle for maxi's home: the
 * local home on maxi itself, the mount of it on mini.
 */
export const HUDDLE_LINKS_PATH =
  process.env.TELEGRAM_HUDDLE_LINKS ?? join(process.env.MAXI || homedir(), '.agents', 'Page', 'huddle-links.json')
/** A read slower than this is an unreadable file: a send never waits on a hung mount. */
export const HUDDLE_LINKS_TIMEOUT_MS = 1000

/**
 * The reader reply and edit_message call once per message. Undefined for a
 * file that is missing, unreadable, not the published shape, or slow. One read
 * at a time: while one is still out on a hung mount, the next is not started.
 */
export function huddleLinksReader(
  path: string = HUDDLE_LINKS_PATH,
  timeoutMs: number = HUDDLE_LINKS_TIMEOUT_MS,
): () => Promise<HuddleLinks | undefined> {
  let pending = false
  return async () => {
    if (pending) return undefined
    pending = true
    const read = readFile(path, 'utf8').then(parseHuddleLinks, () => undefined).finally(() => { pending = false })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs) })
    try {
      return await Promise.race([read, late])
    } finally {
      clearTimeout(timer)
    }
  }
}

export function parseHuddleLinks(raw: string): HuddleLinks | undefined {
  let d: unknown
  try { d = JSON.parse(raw) } catch { return undefined }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return undefined
  const out: HuddleLinks = {}
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    const e = v as { link?: unknown; open?: unknown } | null
    if (e && typeof e === 'object' && typeof e.link === 'string' && typeof e.open === 'boolean') out[k] = { link: e.link, open: e.open }
  }
  return out
}

/** A link huddle may publish: a t.me link, with nothing that could end a MarkdownV2 URL early. */
const ITEM_LINK = /^https:\/\/t\.me\/[^\s()\\]+$/

function itemUrl(links: HuddleLinks | undefined, digits: string): string | undefined {
  if (!links || !/^[1-9]\d*$/.test(digits) || !Object.hasOwn(links, digits)) return undefined
  const e = links[digits]
  return e.open === true && ITEM_LINK.test(e.link) ? e.link : undefined
}

export type Ref = { start: number; end: number; url: string }

// Where nothing is linked: a fenced block (an unclosed one runs to the end), a
// code span, a markdown link or image with its URL, a URL with a scheme, a
// www. address, and a bare domain with a path (t.me/c/1/2, github.com/a/b#3).
const FENCE = '```[\\s\\S]*?(?:```|$)'
const SPAN = '`[^`\\n]*`'
const MD_LINK = '!?\\[(?:\\\\.|[^\\]\\\\\\n])*\\]\\((?:\\\\.|[^)\\\\\\n])*\\)'
const SCHEME_URL = '\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s<>]+'
const WWW = '\\bwww\\\\?\\.[^\\s<>]+'
const BARE = '(?<![\\w@.-])(?:[a-z0-9-]+\\\\?\\.)+[a-z]{2,}\\/[^\\s<>]*'
const PROTECT_PLAIN = new RegExp([FENCE, SPAN, MD_LINK, SCHEME_URL, WWW, BARE].join('|'), 'gi')
// MarkdownV2: a backslash escapes the next character, so \` opens no code span
// and \[ no link. The pair is stepped over; it protects nothing by itself.
const PROTECT_MD = new RegExp(['(\\\\[\\s\\S])', FENCE, SPAN, MD_LINK, SCHEME_URL, WWW, BARE].join('|'), 'gi')

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)'

function patterns(md: boolean) {
  // In MarkdownV2 the agent writes `\#47` and `monty\-ops\#12`: an optional
  // backslash stands before each character Telegram makes it escape.
  const E = md ? '\\\\?' : ''
  // The number ends there: not 47th, 47.5, 47,000, 47:30, 47% or "47 November".
  const END = `(?!\\w|${E}[.,:]\\d|%|\\s+${MONTHS})`
  return {
    // owner/repo#123 or repo#123. Not after a path or a word: ~/dev/agents#1 is a path.
    issue: new RegExp(`(?<![\\w/.~@#\\\\-])(?:([a-z0-9](?:${E}-|[a-z0-9])*)\\/)?((?:${E}[-._]|[a-z0-9])+)${E}#(\\d+)(?!\\w)`, 'gid'),
    items: [
      // `#47`: the whole reference is the link.
      { re: new RegExp(`(?<![\\w#/&\\\\])(${E}#(\\d+))${END}`, 'gid'), span: 1, num: 2 },
      // `item 47`: the phrase is the link.
      { re: new RegExp(`(?<![\\w/-])(item\\s+(\\d+))${END}`, 'gid'), span: 1, num: 2 },
      // `on 47`: the number is the link.
      { re: new RegExp(`(?<![\\w/-])on\\s+((\\d+))${END}`, 'gid'), span: 1, num: 2 },
      // A message or line that opens `47 is`, `47:` or `47,`.
      { re: new RegExp(`^[ \\t]*((\\d+))(?= is\\b|:(?!\\d)|,(?!\\d))`, 'gimd'), span: 1, num: 2 },
    ],
  }
}
const PATTERNS = { plain: patterns(false), md: patterns(true) }

/**
 * Every reference in `text` that becomes a link, in order, none overlapping
 * another or a protected stretch. `ownUrl` says the text already holds a URL
 * or a link of the agent's own.
 */
export function findRefs(text: string, links: HuddleLinks | undefined, md: boolean): { refs: Ref[]; ownUrl: boolean } {
  const taken: Array<[number, number]> = []
  let ownUrl = false
  const protect = md ? PROTECT_MD : PROTECT_PLAIN
  protect.lastIndex = 0
  for (let m = protect.exec(text); m; m = protect.exec(text)) {
    if (m[0].length === 0) { protect.lastIndex++; continue }
    if (md && m[1] !== undefined) continue
    taken.push([m.index, m.index + m[0].length])
    if (!m[0].startsWith('`')) ownUrl = true
  }
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b)
  const refs: Ref[] = []
  const take = (s: number, e: number, url: string) => {
    if (!free(s, e)) return
    taken.push([s, e])
    refs.push({ start: s, end: e, url })
  }
  const p = md ? PATTERNS.md : PATTERNS.plain
  const bare = (s: string) => s.replace(/\\/g, '')

  p.issue.lastIndex = 0
  for (let m = p.issue.exec(text); m; m = p.issue.exec(text)) {
    const owner = m[1] !== undefined ? bare(m[1]) : undefined
    const repo = bare(m[2])
    const full = owner !== undefined ? `${owner}/${repo}`
      : Object.hasOwn(ISSUE_REPOS, repo.toLowerCase()) ? ISSUE_REPOS[repo.toLowerCase()] : undefined
    if (full === undefined) continue
    take(m.index, m.index + m[0].length, `https://github.com/${full}/issues/${Number(m[3])}`)
  }
  for (const { re, span, num } of p.items) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const url = itemUrl(links, m[num])
      const at = m.indices?.[span]
      if (url === undefined || !at) continue
      take(at[0], at[1], url)
    }
  }
  refs.sort((a, b) => a.start - b.start)
  return { refs, ownUrl }
}

export type TextLink = { type: 'text_link'; offset: number; length: number; url: string }

/**
 * One outbound text with its references linked. `refs` are positions in
 * `text`. Plain text is returned as it is, with entities; MarkdownV2 is
 * rewritten. A MarkdownV2 text that linking would push past `limit` is
 * returned unlinked: a message that goes out plain beats one Telegram refuses.
 */
export function applyRefs(text: string, refs: Ref[], md: boolean, limit: number): { text: string; entities?: TextLink[]; linked: number } {
  if (refs.length === 0) return { text, linked: 0 }
  if (!md) {
    return { text, entities: refs.map(r => ({ type: 'text_link', offset: r.start, length: r.end - r.start, url: r.url })), linked: refs.length }
  }
  let out = ''
  let at = 0
  for (const r of refs) {
    out += `${text.slice(at, r.start)}[${text.slice(r.start, r.end)}](${r.url.replace(/[\\)]/g, '\\$&')})`
    at = r.end
  }
  out += text.slice(at)
  return out.length > limit ? { text, linked: 0 } : { text: out, linked: refs.length }
}

/**
 * The linked form of each chunk of one message. The references are found in
 * the whole text, so a code block cut across two chunks still protects what
 * is in it; a reference a chunk boundary cuts through is left plain.
 */
export function linkChunks(
  text: string,
  chunks: string[],
  links: HuddleLinks | undefined,
  md: boolean,
  limit: number,
): Array<{ text: string; entities?: TextLink[]; linked: number; ownUrl: boolean }> {
  const { refs, ownUrl } = findRefs(text, links, md)
  let cursor = 0
  return chunks.map(c => {
    const start = text.indexOf(c, cursor)
    if (start < 0) return { text: c, linked: 0, ownUrl }
    const end = start + c.length
    cursor = end
    const mine = refs.filter(r => r.start >= start && r.end <= end).map(r => ({ start: r.start - start, end: r.end - start, url: r.url }))
    return { ...applyRefs(c, mine, md, limit), ownUrl }
  })
}

/**
 * What a linked text adds to the Telegram call: its entities, and no preview
 * card for a link the bridge added when the agent's text held no URL of its
 * own, so a message reads as it did before its references were links.
 */
export function linkOptions(l: { entities?: TextLink[]; linked: number; ownUrl: boolean }): Record<string, unknown> {
  return {
    ...(l.entities ? { entities: l.entities } : {}),
    ...(l.linked > 0 && !l.ownUrl ? { link_preview_options: { is_disabled: true } } : {}),
  }
}

// --- 3. THE SEND PATH -----------------------------------------------------------------

/**
 * The reply tool's send path: chunk the text, send each chunk, then send each
 * file. Kept out of server.ts because importing server.ts starts the bot, and
 * the send path is what the post log and the tag relay hang off.
 *
 * Everything that touches the outside world comes in through `deps`, so a test
 * can hand it a stub API and see exactly what was sent.
 */

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
   * huddle's published links, read once per reply (part 2). Absent, or
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
  // His items and issue references become links here (part 2). The log, the
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

/** The react tool. Gated like every outbound tool: never into a private chat (part 1). */
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
  // Linked as a reply is (part 2). The log keeps the text the agent wrote.
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
