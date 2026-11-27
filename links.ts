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

import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

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
