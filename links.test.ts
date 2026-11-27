// The bridge links every item and issue reference (links.ts).
// Design: agents/Grady/design/DESIGN-bridge-links-references-2026-11-27, item
// 4: each form linked; a closed or unknown number left plain; a number in a
// code span or URL left plain; a missing file sends unchanged; MarkdownV2
// escaping holds; an issue link for each short name. Each test below has a
// revert in revert-proofs.py (ids LK*).
//
// Nothing here reaches Telegram or Monty. The unit tests hand the code a stub
// API; the end-to-end tests run the real server.ts as a subprocess under a
// temp HOME, with a local stub standing in for the Bot API and a stub links
// file where huddle's would be.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runReply, runEditMessage, type ReplyDeps } from './reply.ts'
import { ISSUE_REPOS, findRefs, huddleLinksReader, type HuddleLinks } from './links.ts'
import { TAIL_FLEET_POSTS_BIN } from './peer-posts.ts'

setDefaultTimeout(30_000)

const GROUP = '-1004286764447'
const L47 = 'https://t.me/c/4286764447/40/3900'
const L12 = 'https://t.me/c/4286764447/38/1200'
/** 47 and 12 are open with a message; 48 is closed; 50 is open with no message. */
const LINKS: HuddleLinks = {
  '12': { link: L12, open: true },
  '47': { link: L47, open: true },
  '48': { link: 'https://t.me/c/4286764447/40/3901', open: false },
  '50': { link: '', open: true },
}

const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups) c() })

type Call = { method: string; text: string; other: Record<string, any> }
function harness(links: ReplyDeps['links'] = async () => LINKS) {
  const calls: Call[] = []
  const logged: Array<{ text?: string }> = []
  const noted: string[] = []
  let id = 900
  const deps: ReplyDeps = {
    api: {
      sendMessage: async (_c, text, other) => { calls.push({ method: 'sendMessage', text, other: other ?? {} }); return { message_id: id++ } },
      sendPhoto: async () => ({ message_id: id++ }),
      sendDocument: async () => ({ message_id: id++ }),
    },
    loadAccess: () => ({}),
    assertAllowedChat: () => {},
    assertSendable: () => {},
    stopTyping: () => {},
    tee: e => { logged.push(e as { text?: string }) },
    sent: p => { noted.push(p.text) },
    links,
  }
  const editDeps = {
    api: { editMessageText: async (_c: string, _m: number, text: string, other?: Record<string, unknown>) => { calls.push({ method: 'editMessageText', text, other: other ?? {} }); return true as const } },
    assertAllowedChat: () => {},
    tee: (e: unknown) => { logged.push(e as { text?: string }) },
    links,
  }
  return {
    calls, logged, noted,
    reply: (text: string, format?: string) => runReply(deps, { chat_id: GROUP, text, ...(format ? { format } : {}) }),
    edit: (text: string, format?: string) => runEditMessage(editDeps, { chat_id: GROUP, message_id: '900', text, ...(format ? { format } : {}) }),
  }
}

/** What a plain-text send links: [the linked words, the url] for each entity, in order. */
function linkedIn(c: Call): Array<[string, string]> {
  return ((c.other.entities ?? []) as Array<{ type: string; offset: number; length: number; url: string }>)
    .map(e => { expect(e.type).toBe('text_link'); return [c.text.slice(e.offset, e.offset + e.length), e.url] })
}
async function plain(text: string, links?: ReplyDeps['links']): Promise<Array<[string, string]>> {
  const h = harness(links)
  await h.reply(text)
  expect(h.calls).toHaveLength(1)
  expect(h.calls[0].text).toBe(text)                // a plain-text message is never rewritten
  expect(h.calls[0].other.parse_mode).toBeUndefined()
  return linkedIn(h.calls[0])
}
async function md(text: string): Promise<string> {
  const h = harness()
  await h.reply(text, 'markdownv2')
  expect(h.calls[0].other.parse_mode).toBe('MarkdownV2')
  expect(h.calls[0].other.entities).toBeUndefined()
  return h.calls[0].text
}

// --- item 4: each form linked -------------------------------------------------------

test('links: #47 is a link to item 47\'s message', async () => {
  expect(await plain('Done with #47 today.')).toEqual([['#47', L47]])
  expect(await plain('#47')).toEqual([['#47', L47]])
  expect(await plain('(#47) and #12.')).toEqual([['#47', L47], ['#12', L12]])
})

test('links: item 47 is a link, the phrase whole', async () => {
  expect(await plain('I am working item 47 now')).toEqual([['item 47', L47]])
  expect(await plain('Item 47 is next')).toEqual([['Item 47', L47]])
})

test('links: on 47 is a link, the number alone', async () => {
  expect(await plain('Your yes on 47 landed.')).toEqual([['47', L47]])
  expect(await plain('On 47, nothing yet')).toEqual([['47', L47]])
})

test('links: a message or a line that opens 47 is, 47: or 47, is a link', async () => {
  expect(await plain('47 is done')).toEqual([['47', L47]])
  expect(await plain('47: done')).toEqual([['47', L47]])
  expect(await plain('47, done')).toEqual([['47', L47]])
  expect(await plain('Status\n47 is done\n  12: waiting')).toEqual([['47', L47], ['12', L12]])
})

test('links: a bare number anywhere else is not a reference', async () => {
  expect(await plain('I counted 47 of them and 47 is the total')).toEqual([])
  expect(await plain('47 hosts, and 47')).toEqual([])
  expect(await plain('at 47:30 or 47,000 or 47.5')).toEqual([])
  expect(await plain('on 47th, on 47.5, on 47%, on 47 November, on 47:30, item 470')).toEqual([])
  expect(await plain('47:30 is the time')).toEqual([])
})

// --- a closed or unknown number left plain --------------------------------------------

test('links: a closed number, an unknown number and an open one with no message stay plain', async () => {
  expect(await plain('#48 and item 48, on 48\n48: closed')).toEqual([])
  expect(await plain('#49 and item 49, on 49\n49: never numbered')).toEqual([])
  expect(await plain('#50 is open and has no message')).toEqual([])
  expect(await plain('#047 is not how huddle writes 47')).toEqual([])
  expect(await plain('#48 closed, #47 open')).toEqual([['#47', L47]])
})

test('links: a links file entry that is not a t.me link, or not open: true, links nothing', async () => {
  const odd = async () => ({
    '47': { link: 'https://example.com/x', open: true },
    '12': { link: L12, open: 'yes' },
    '13': { link: 'https://t.me/c/1/2) [x](https://example.com', open: true },
  } as unknown as HuddleLinks)
  expect(await plain('#47 and #12 and #13', odd)).toEqual([])
})

// --- a number in a code span or URL left plain ----------------------------------------

test('links: nothing inside a code span or a code block is linked', async () => {
  expect(await plain('run `huddle answer #47 yes` for #47')).toEqual([['#47', L47]])
  expect(await plain('```\n47: x\nitem 47 on 47 agents#1\n```\n#12')).toEqual([['#12', L12]])
  expect(await plain('an unclosed block\n```\n#47 agents#1')).toEqual([])
  expect(await md('`item 47` and `agents\\#1`')).toBe('`item 47` and `agents\\#1`')
})

test('links: nothing inside a URL or an existing link is linked', async () => {
  expect(await plain('see https://github.com/mkosma/agents/issues/9#47 and github.com/mkosma/agents#47 and t.me/c/1/2#47')).toEqual([])
  expect(await plain('see https://example.com/page, then item 47')).toEqual([['item 47', L47]])
  expect(await plain('[on 47](https://example.com/#47)')).toEqual([])
  const own = '[\\#47](https://example.com/a) and [agents\\#1](https://example.com/b) and https://example\\.com/x\\#47'
  expect(await md(own)).toBe(own)
})

test('links: a path is not an issue reference', async () => {
  expect(await plain('~/dev/agents#1 and /srv/dev/agents#1 and x.agents#1 and foo-agents#1')).toEqual([])
})

// --- a missing file sends unchanged ---------------------------------------------------

test('links: a missing, unreadable, misshapen or slow links file links no items and the message is sent as written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'))
  const garbage = join(dir, 'garbage.json'); writeFileSync(garbage, '{"47": {"link": "https://t.me/c/1/2/3", "op')
  const array = join(dir, 'array.json'); writeFileSync(array, '["promise:x"]')
  const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify(LINKS))
  const text = 'Your yes on 47 landed, #47 is item 47.\n47: done'
  expect(await plain(text, huddleLinksReader(join(dir, 'absent.json')))).toEqual([])
  expect(await plain(text, huddleLinksReader(garbage))).toEqual([])
  expect(await plain(text, huddleLinksReader(array))).toEqual([])
  expect(await plain(text, huddleLinksReader(dir))).toEqual([])
  expect(await plain(text, async () => { throw new Error('mount gone') })).toEqual([])
  expect(await plain(text, undefined as unknown as ReplyDeps['links'])).toHaveLength(4)   // the harness default: the stub file
  // The same reader over the file huddle wrote links all four.
  expect(await plain(text, huddleLinksReader(good))).toEqual([['47', L47], ['#47', L47], ['item 47', L47], ['47', L47]])
  // And an edit goes out the same way.
  const h = harness(huddleLinksReader(join(dir, 'absent.json')))
  await h.edit(text)
  expect(h.calls[0]).toEqual({ method: 'editMessageText', text, other: {} })
})

test('links: a read that hangs is given up on, and the next read is not started behind it', async () => {
  const fifo = join(mkdtempSync(join(tmpdir(), 'links-fifo-')), 'huddle-links.json')
  Bun.spawnSync(['mkfifo', fifo])                     // a read of a fifo with no writer never returns: a hung mount
  // A writer turns up after 3s, long after the assertions, so no read is left out when the test process exits.
  const release = Bun.spawn(['sh', '-c', 'sleep 3; echo "{}" > "$1"', 'sh', fifo], { stdout: 'ignore', stderr: 'ignore' })
  cleanups.push(() => release.kill())
  const read = huddleLinksReader(fifo, 150)
  const t0 = Date.now()
  expect(await plain('#47', read)).toEqual([])
  const first = Date.now() - t0
  expect(first).toBeGreaterThanOrEqual(140)
  expect(first).toBeLessThan(2000)
  const t1 = Date.now()
  expect(await plain('#47', read)).toEqual([])
  expect(Date.now() - t1).toBeLessThan(100)           // the first read is still out: no second one, no second wait
  await release.exited
})

test('links: an issue reference is linked with no links file at all', async () => {
  expect(await plain('#47 and agents#12', huddleLinksReader(join(tmpdir(), 'no-such-links-file.json')))).toEqual([['agents#12', 'https://github.com/mkosma/agents/issues/12']])
  const calls: Call[] = []
  await runReply({
    api: { sendMessage: async (_c, text, other) => { calls.push({ method: 'sendMessage', text, other: other ?? {} }); return { message_id: 1 } }, sendPhoto: async () => ({ message_id: 2 }), sendDocument: async () => ({ message_id: 3 }) },
    loadAccess: () => ({}), assertAllowedChat: () => {}, assertSendable: () => {}, stopTyping: () => {},
  }, { chat_id: GROUP, text: '#47 and deck#3' })
  expect(linkedIn(calls[0])).toEqual([['deck#3', 'https://github.com/chironic/chironic-deck/issues/3']])
})

// --- MarkdownV2 escaping holds --------------------------------------------------------

test('links: in MarkdownV2 each reference is wrapped as written, escapes kept, and the rest is untouched', async () => {
  expect(await md('Your yes on 47 landed\\.')).toBe(`Your yes on [47](${L47}) landed\\.`)
  expect(await md('Done with \\#47\\!')).toBe(`Done with [\\#47](${L47})\\!`)
  expect(await md('*item 47* is next\\.')).toBe(`*[item 47](${L47})* is next\\.`)
  expect(await md('47: done\\.\n12, waiting')).toBe(`[47](${L47}): done\\.\n[12](${L12}), waiting`)
  expect(await md('see monty\\-ops\\#7, agents\\#12 and chironic/chironic\\-deck\\#3\\.')).toBe(
    'see [monty\\-ops\\#7](https://github.com/mkosma/monty-ops/issues/7), [agents\\#12](https://github.com/mkosma/agents/issues/12) and [chironic/chironic\\-deck\\#3](https://github.com/chironic/chironic-deck/issues/3)\\.')
  // An escaped bracket or backtick opens nothing, so what follows it is still linked.
  expect(await md('\\[draft\\] on 47 and \\`not code \\#12')).toBe(`\\[draft\\] on [47](${L47}) and \\\`not code [\\#12](${L12})`)
  expect(await md('\\`on 47\\` is not code')).toBe(`\\\`on [47](${L47})\\\` is not code`)
  // A closed number keeps its escape and gains nothing.
  expect(await md('\\#48 is closed\\.')).toBe('\\#48 is closed\\.')
})

test('links: a MarkdownV2 message that linking would push past 4096 characters goes out unlinked', async () => {
  const long = 'on 47 ' + 'x'.repeat(4085)
  expect(long.length).toBeLessThanOrEqual(4096)
  expect(await md(long)).toBe(long)
  const fits = 'on 47 ' + 'x'.repeat(1000)
  expect(await md(fits)).toBe(`on [47](${L47}) ` + 'x'.repeat(1000))
})

// --- an issue link for each short name ------------------------------------------------

test('links: agents#N, monty-ops#N, deck#N and owner/repo#N link to that GitHub issue, and no other short name does', async () => {
  expect(ISSUE_REPOS).toEqual({ agents: 'mkosma/agents', 'monty-ops': 'mkosma/monty-ops', deck: 'chironic/chironic-deck' })
  expect(await plain('agents#123')).toEqual([['agents#123', 'https://github.com/mkosma/agents/issues/123']])
  expect(await plain('see monty-ops#45.')).toEqual([['monty-ops#45', 'https://github.com/mkosma/monty-ops/issues/45']])
  expect(await plain('(deck#6)')).toEqual([['deck#6', 'https://github.com/chironic/chironic-deck/issues/6']])
  expect(await plain('oven-sh/bun#99 and Agents#2')).toEqual([['oven-sh/bun#99', 'https://github.com/oven-sh/bun/issues/99'], ['Agents#2', 'https://github.com/mkosma/agents/issues/2']])
  expect(await plain('memex#4 and ops#47 and bridge#12')).toEqual([])      // no such short name; and never item 47
})

// --- reply and edit_message, and what stays as the agent wrote it ---------------------

test('links: edit_message links as reply does, in both formats', async () => {
  const h = harness()
  await h.edit('on 47 and agents#1')
  expect(h.calls[0].method).toBe('editMessageText')
  expect(h.calls[0].text).toBe('on 47 and agents#1')
  expect(linkedIn(h.calls[0])).toEqual([['47', L47], ['agents#1', 'https://github.com/mkosma/agents/issues/1']])
  expect(h.calls[0].other.parse_mode).toBeUndefined()
  await h.edit('on 47 and agents\\#1', 'markdownv2')
  expect(h.calls[1].text).toBe(`on [47](${L47}) and [agents\\#1](https://github.com/mkosma/agents/issues/1)`)
  expect(h.calls[1].other.parse_mode).toBe('MarkdownV2')
  await h.edit('nothing to link')
  expect(h.calls[2]).toEqual({ method: 'editMessageText', text: 'nothing to link', other: {} })
})

test('links: in a reply sent in parts each part carries its own links, counted from its own start', async () => {
  const text = 'on 47 ' + 'a'.repeat(4090) + '\n\n' + 'b'.repeat(50) + ' #12 agents#3'
  const h = harness()
  await h.reply(text)
  expect(h.calls.length).toBe(2)
  expect(h.calls.map(c => c.text).join('').length).toBeGreaterThan(4096)
  expect(linkedIn(h.calls[0])).toEqual([['47', L47]])
  expect(linkedIn(h.calls[1])).toEqual([['#12', L12], ['agents#3', 'https://github.com/mkosma/agents/issues/3']])
})

test('links: the post log and the pin record keep the text the agent wrote', async () => {
  const h = harness()
  await h.reply('on 47 and agents\\#1', 'markdownv2')
  expect(h.calls[0].text).toContain(`[47](${L47})`)
  expect(h.logged.map(e => e.text)).toEqual(['on 47 and agents\\#1'])
  expect(h.noted).toEqual(['on 47 and agents\\#1'])
  await h.edit('on 47 and agents\\#1', 'markdownv2')
  expect(h.logged[1].text).toBe('on 47 and agents\\#1')
})

test('links: a link the bridge added shows no preview card, and a URL of the agent\'s own still does', async () => {
  const h = harness()
  await h.reply('see agents#1')
  expect(h.calls[0].other.link_preview_options).toEqual({ is_disabled: true })
  await h.reply('see agents#1 and https://example.com/page')
  expect(linkedIn(h.calls[1])).toHaveLength(1)
  expect(h.calls[1].other.link_preview_options).toBeUndefined()
  await h.reply('see https://example.com/page')
  expect(h.calls[2].other).toEqual({})
  await h.reply('nothing to link')
  expect(h.calls[3].other).toEqual({})
})

test('links: findRefs reports each reference once, in order, never overlapping', () => {
  const { refs } = findRefs('item 47: #47 on 47, agents#47', LINKS, false)
  expect(refs.map(r => [r.start, r.end])).toEqual([[0, 7], [9, 12], [16, 18], [20, 29]])
})

// --- end to end: the real server.ts, a stub Bot API, a stub links file ----------------

const TOKEN = '123456:TEST-ONLY-fixture-token-never-live'
const BOT = 'MK_TestyBot'

function startStub() {
  const calls: Array<{ method: string; body: Record<string, any> }> = []
  let nextMessageId = 5000
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname)
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (!m || m[1] !== TOKEN) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
      let body: Record<string, any> = {}
      try { body = await req.json() as Record<string, any> } catch {}
      if (m[2] !== 'getUpdates') calls.push({ method: m[2], body })
      switch (m[2]) {
        case 'getMe':
          return reply(200, { ok: true, result: { id: 42, is_bot: true, first_name: 'Testy', username: BOT, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } })
        case 'getUpdates':
          await Bun.sleep(150)
          return reply(200, { ok: true, result: [] })
        case 'sendMessage':
          return reply(200, { ok: true, result: { message_id: nextMessageId++, date: 1, chat: { id: Number(body.chat_id), type: 'supergroup' }, text: body.text } })
      }
      return reply(200, { ok: true, result: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, of: (method: string) => calls.filter(c => c.method === method) }
}

async function until<T>(probe: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > end) throw new Error(`condition not met within ${ms}ms`)
    await Bun.sleep(25)
  }
}

/** The bridge with $MAXI a temp dir: huddle's file is looked for at $MAXI/.agents/Page/huddle-links.json. */
async function startBridge(stub: ReturnType<typeof startStub>, links: HuddleLinks | undefined) {
  const home = mkdtempSync(join(tmpdir(), 'links-e2e-'))
  const state = join(home, 'state')
  const maxi = join(home, 'maxi-home')
  mkdirSync(state, { recursive: true })
  mkdirSync(join(maxi, '.agents', 'Page'), { recursive: true })
  if (links) writeFileSync(join(maxi, '.agents', 'Page', 'huddle-links.json'), JSON.stringify(links))
  writeFileSync(join(state, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: ['111'], pending: {},
    groups: { [GROUP]: { requireMention: true, allowFrom: [], threads: { '40': { requireMention: false } } } },
  }))
  const p = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      MAXI: maxi,
      TELEGRAM_STATE_DIR: state,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_ROOT: stub.url,
      TELEGRAM_TEE_DIR: join(home, 'tee'),
      TAIL_FLEET_POSTS_BIN,
      TAIL_FLEET_POSTS_HOST: 'maxi',
      TAIL_FLEET_POSTS_DIR: join(home, 'tee'),
      TAIL_FLEET_POSTS_READ_MINI: `${TAIL_FLEET_POSTS_BIN} --dump ${join(home, 'tee')}`,
      PAGE_TOPICS_FILE: join(home, 'no-topics.json'),
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  cleanups.push(() => p.kill('SIGKILL'))
  let out = ''
  let err = ''
  const pump = async (stream: ReadableStream<Uint8Array>, add: (s: string) => void) => {
    const dec = new TextDecoder()
    for await (const chunk of stream) add(dec.decode(chunk, { stream: true }))
  }
  void pump(p.stdout, s => { out += s })
  void pump(p.stderr, s => { err += s })
  const lines = () => out.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const send = (msg: object) => { p.stdin.write(JSON.stringify(msg) + '\n'); p.stdin.flush() }
  let id = 1
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'links-test', version: '0' } } })
  const init = await until(() => lines().find(m => m.id === 1), 20_000)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await until(() => err.includes(`polling as @${BOT}`), 20_000)
  const rpc = async (method: string, params: object) => {
    const mine = ++id
    send({ jsonrpc: '2.0', id: mine, method, params })
    return (await until(() => lines().find(m => m.id === mine))).result
  }
  return {
    instructions: init.result.instructions as string,
    tools: async () => (await rpc('tools/list', {})).tools as Array<{ name: string; description: string }>,
    call: async (name: string, args: object) => await rpc('tools/call', { name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean },
  }
}

test('end to end: reply and edit_message link "on 47 and agents#1" from the links file huddle wrote', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, { '47': { link: L47, open: true } })
  const sent = await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'on 47 and agents#1' })
  expect(sent.isError).toBeFalsy()
  const body = stub.of('sendMessage')[0].body
  expect(body.text).toBe('on 47 and agents#1')
  expect(body.parse_mode).toBeUndefined()
  expect(body.entities).toEqual([
    { type: 'text_link', offset: 3, length: 2, url: L47 },
    { type: 'text_link', offset: 10, length: 8, url: 'https://github.com/mkosma/agents/issues/1' },
  ])
  expect(body.link_preview_options).toEqual({ is_disabled: true })

  const mdSent = await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'on 47 and agents\\#1', format: 'markdownv2' })
  expect(mdSent.isError).toBeFalsy()
  expect(stub.of('sendMessage')[1].body.text).toBe(`on [47](${L47}) and [agents\\#1](https://github.com/mkosma/agents/issues/1)`)
  expect(stub.of('sendMessage')[1].body.parse_mode).toBe('MarkdownV2')

  const edited = await bridge.call('edit_message', { chat_id: GROUP, message_id: '5000', text: 'still on 47' })
  expect(edited.isError).toBeFalsy()
  const edit = stub.of('editMessageText')[0].body
  expect(edit.text).toBe('still on 47')
  expect(edit.entities).toEqual([{ type: 'text_link', offset: 9, length: 2, url: L47 }])
})

test('end to end: with no links file the reply goes out as written, and an issue is still linked', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, undefined)
  const sent = await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'on 47 and #47' })
  expect(sent.isError).toBeFalsy()
  expect(stub.of('sendMessage')[0].body.text).toBe('on 47 and #47')
  expect(stub.of('sendMessage')[0].body.entities).toBeUndefined()
  await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'on 47 and agents#1' })
  expect(stub.of('sendMessage')[1].body.entities).toEqual([{ type: 'text_link', offset: 10, length: 8, url: 'https://github.com/mkosma/agents/issues/1' }])
})

test('end to end: the instructions and the reply tool say to write #47 and repo#123, and that the bridge links them', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, undefined)
  expect(bridge.instructions).toContain('Refer to Monty\'s numbered items as #47 and to GitHub issues as repo#123')
  expect(bridge.instructions).toContain('The bridge turns each into a link')
  for (const name of Object.keys(ISSUE_REPOS)) expect(bridge.instructions).toContain(`${name}#123`)
  const reply = (await bridge.tools()).find(t => t.name === 'reply')!
  expect(reply.description).toContain('#47')
  expect(reply.description).toContain('repo#123; the bridge links them')
})
