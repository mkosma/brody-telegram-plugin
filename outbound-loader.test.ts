// The bridge re-reads its outbound rules without a restart (outbound-loader.ts).
//
// The drill of DESIGN-bridge-hot-reloads-outbound-rules-2026-11-27, item 6.
//
// NO TEST HERE POSTS TO TELEGRAM OR RUNS THE REAL fleet-andon. The unit tests
// hand the loader a function that records the arguments; the end-to-end tests
// run the real server.ts from a copy of this tree, under a temp HOME, against
// a stub Bot API on 127.0.0.1 and a stub fleet-andon that writes its arguments
// to a file.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, symlinkSync, realpathSync, chmodSync, existsSync, rmSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { join } from 'path'
import { outboundLoader, OUTBOUND_EXPORTS, OUTBOUND_PATH, reloadAlertKey, type Outbound } from './outbound-loader.ts'
import { PRIVATE_CHAT_REFUSAL } from './outbound.ts'
import { TAIL_FLEET_POSTS_BIN } from './peer-posts.ts'

setDefaultTimeout(60_000)

const HOST = 'testhost'
const KEY = `bridge-reload:${HOST}`

// --- the loader: unit -----------------------------------------------------------------

/** A stand-in outbound.ts: every expected export, each answering with this version's tag. */
const version = (tag: string, drop: string[] = []) =>
  OUTBOUND_EXPORTS.filter(n => !drop.includes(n)).map(n => `export function ${n}() { return '${tag}' }`).join('\n') + '\n'
const tagOf = (m: Outbound | undefined) => m && (m.runReact as unknown as () => string)()

function rig(first: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-loader-'))
  const path = join(dir, 'outbound.ts')
  if (first !== undefined) writeFileSync(path, first)
  const andon: string[][] = []
  const count = { stats: 0, imports: 0 }
  const loader = outboundLoader({
    path,
    host: HOST,
    whose: "Testy's",
    stamp: p => { count.stats++; const st = Bun.file(p); if (!existsSync(p)) throw new Error('ENOENT'); return `${st.lastModified}:${st.size}` },
    load: (p, n) => { count.imports++; return import(`${p}?reload=${n}`) },
    andon: argv => { andon.push(argv) },
    stderr: () => {},
  })
  // Each write is a different length, so the stamp differs whatever the clock's grain.
  let pad = 0
  const write = (src: string) => writeFileSync(path, src + `// ${'x'.repeat(++pad)}\n`)
  return { path, loader, andon, count, write }
}

test('reload: a changed module takes effect on the next call, with no restart', async () => {
  const r = rig(version('one'))
  expect(tagOf(await r.loader.fresh())).toBe('one')
  r.write(version('two'))
  expect(tagOf(await r.loader.fresh())).toBe('two')
  expect(tagOf(r.loader.current())).toBe('two')
  expect(r.andon).toEqual([])
})

test('reload: an unchanged module is not imported again, and each call costs one stat', async () => {
  const r = rig(version('one'))
  const first = await r.loader.fresh()
  for (let i = 0; i < 5; i++) expect(await r.loader.fresh()).toBe(first)
  expect(r.count).toEqual({ stats: 6, imports: 1 })
})

test('reload: a module with a syntax error keeps the old behavior and raises the P2 once', async () => {
  const r = rig(version('one'))
  await r.loader.fresh()
  r.write('export function runReply( {\n')
  expect(tagOf(await r.loader.fresh())).toBe('one')
  expect(tagOf(await r.loader.fresh())).toBe('one')
  r.write('export function runReply( { still broken\n')
  expect(tagOf(await r.loader.fresh())).toBe('one')
  expect(r.andon.length).toBe(1)
  expect(r.andon[0].slice(0, 6)).toEqual(['--severity', 'P2', '--owner', 'Grady', '--key', KEY])
  expect(r.andon[0][r.andon[0].indexOf('--message') + 1]).toContain("Testy's bridge on testhost")
  expect(r.andon[0][r.andon[0].indexOf('--message') + 1]).toContain('is sending with the last version that loaded')
  // The bad file was imported once per change, not once per call.
  expect(r.count.imports).toBe(3)
})

test('reload: a module missing an export keeps the old behavior and raises the P2 once', async () => {
  const r = rig(version('one'))
  await r.loader.fresh()
  r.write(version('two', ['runEditMessage', 'exempt']))
  expect(tagOf(await r.loader.fresh())).toBe('one')
  expect(tagOf(await r.loader.fresh())).toBe('one')
  expect(r.andon.length).toBe(1)
  expect(r.andon[0][r.andon[0].indexOf('--message') + 1]).toContain('it does not export exempt, runEditMessage')
})

test('reload: a good module after a bad one is loaded and resolves the P2, once', async () => {
  const r = rig(version('one'))
  await r.loader.fresh()
  r.write('export const = \n')
  await r.loader.fresh()
  r.write(version('three'))
  expect(tagOf(await r.loader.fresh())).toBe('three')
  r.write(version('four'))
  expect(tagOf(await r.loader.fresh())).toBe('four')
  expect(r.andon.length).toBe(2)
  expect(r.andon[1]).toEqual(['--key', KEY, '--resolve', '--owner', 'Grady'])
})

test('reload: a file that is bad or missing at launch loads nothing, raises the P2, and is loaded by the first call after it is good', async () => {
  for (const first of ['export const = \n', undefined]) {
    const r = rig(first)
    expect(await r.loader.fresh()).toBeUndefined()
    expect(await r.loader.fresh()).toBeUndefined()
    expect(() => r.loader.need()).toThrow('the bridge has no outbound rules loaded')
    expect(r.andon.length).toBe(1)
    expect(r.andon[0][r.andon[0].indexOf('--message') + 1]).toContain('has no version to send with')
    r.write(version('one'))
    expect(tagOf(await r.loader.fresh())).toBe('one')
    expect(tagOf(r.loader.need())).toBe('one')
    expect(r.andon.map(a => a.includes('--resolve'))).toEqual([false, true])
  }
})

test('reload: calls that arrive during a reload all get the new version, from one import', async () => {
  const r = rig(version('one'))
  await r.loader.fresh()
  r.write(version('two'))
  const got = await Promise.all([r.loader.fresh(), r.loader.fresh(), r.loader.fresh()])
  expect(got.map(tagOf)).toEqual(['two', 'two', 'two'])
  expect(r.count.imports).toBe(2)
})

test('reload: the real outbound.ts exports every function the server calls, and the default loader loads it by its mtime and size', async () => {
  const andon: string[][] = []
  const loader = outboundLoader({ andon: argv => { andon.push(argv) }, stderr: () => {} })
  const rules = await loader.fresh()
  for (const name of OUTBOUND_EXPORTS) expect(typeof (rules as Record<string, unknown>)[name]).toBe('function')
  expect(await loader.fresh()).toBe(rules!)
  expect(andon).toEqual([])
  expect(reloadAlertKey('maxi')).toBe('bridge-reload:maxi')
})

test('reload: an exemption marked under one version is honored by the next', async () => {
  const a = await import(`${OUTBOUND_PATH}?reload=mark-a`) as typeof import('./outbound.ts')
  const b = await import(`${OUTBOUND_PATH}?reload=mark-b`) as typeof import('./outbound.ts')
  expect(a.refusePrivateChat).not.toBe(b.refusePrivateChat)
  const sent: unknown[] = []
  const prev = async (_m: never, payload: never) => { sent.push(payload); return true }
  await b.refusePrivateChat(prev, 'sendMessage', { chat_id: 111, text: 'Paired!', ...a.exempt('pairing') })
  expect(sent.length).toBe(1)
  // And a string key of the same name is still no way through: tool arguments are JSON.
  await expect(b.refusePrivateChat(prev, 'sendMessage', { chat_id: 111, text: 'x', 'private-chat-exemption': 'pairing' })).rejects.toThrow(PRIVATE_CHAT_REFUSAL)
})

// --- the wiring ---------------------------------------------------------------------

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')

test('reload: server.ts never imports outbound.ts for its code, and looks at the disk before each tool call', () => {
  const server = src('server.ts')
  // A type import is erased; any other import of the file would pin the launch version.
  expect([...server.matchAll(/^import (.*) from '\.\/outbound\.ts'$/gm)].map(m => m[1])).toEqual(['type { PrivateChatExemption }'])
  expect(server).not.toContain("import('./outbound.ts')")
  expect(server).toContain("  try {\n    // The outbound rules as they are on disk now: one stat when nothing changed.\n    await outbound.fresh()\n    switch (req.params.name) {")
  for (const name of ['assertOutboundChat', 'runReply', 'runReact', 'runEditMessage']) {
    expect(server).toContain(`const ${name}: Outbound['${name}'] = (...a) => outbound.need().${name}(...a)`)
  }
})

// --- end to end: the real server.ts, from a copy of this tree, against a stub Bot API ---

const TOKEN = '123456:TEST-ONLY-fixture-token-never-live'
const BOT = 'MK_TestyBot'
const GROUP = '-1004286764447'
const MONTY = '111'
const ISSUE = 'https://github.com/mkosma/agents/issues/1'
const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups) c() })

type StubCall = { method: string; body: Record<string, any> }
function startStub() {
  const calls: StubCall[] = []
  const queue: object[] = []
  let updateId = 1000
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
        case 'getUpdates': {
          if (queue.length === 0) await Bun.sleep(150)
          return reply(200, { ok: true, result: queue.splice(0).map(u => ({ update_id: updateId++, ...u })) })
        }
        case 'sendMessage':
          return reply(200, { ok: true, result: { message_id: nextMessageId++, date: 1, chat: { id: Number(body.chat_id), type: Number(body.chat_id) > 0 ? 'private' : 'supergroup' }, text: body.text } })
      }
      return reply(200, { ok: true, result: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    of: (method: string) => calls.filter(c => c.method === method),
    into: (chat_id: string) => calls.filter(c => String(c.body.chat_id) === chat_id).map(c => c.method),
    push: (u: object) => { queue.push(u) },
  }
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

const REAL = src('outbound.ts')

/** `REAL` with one stretch replaced; a replacement that is not found exactly once is an error, not a no-op. */
function without(source: string, original: string, replaced: string): string {
  const n = source.split(original).length - 1
  if (n !== 1) throw new Error(`expected once in outbound.ts, found ${n} times: ${original}`)
  return source.replace(original, replaced)
}

/** outbound.ts as it was before today's two changes: no private-chat refusal, no links. */
const BEFORE = [
  ['    if (exemption === undefined || !Object.hasOwn(PRIVATE_CHAT_EXEMPTIONS, exemption)) throw new Error(PRIVATE_CHAT_REFUSAL)\n', ''],
  ["  if (isPrivateChatId(p.chat_id) && !method.startsWith('get') && !exemptionCovers(p[EXEMPT], method)) {", '  if (false) {'],
  ['  const { refs, ownUrl } = findRefs(text, links, md)\n', '  const { refs, ownUrl } = { refs: [] as Ref[], ownUrl: false }\n'],
].reduce((s, [a, b]) => without(s, a, b), REAL)

async function startBridge(stub: ReturnType<typeof startStub>, outbound: string) {
  const home = mkdtempSync(join(tmpdir(), 'outbound-reload-e2e-'))
  // The server runs from a copy of the tree, so the test can deploy to it.
  const tree = join(home, 'tree')
  mkdirSync(tree)
  for (const f of readdirSync(import.meta.dir)) {
    if ((f.endsWith('.ts') && !f.endsWith('.test.ts')) || f === 'package.json') copyFileSync(join(import.meta.dir, f), join(tree, f))
  }
  symlinkSync(realpathSync(join(import.meta.dir, 'node_modules')), join(tree, 'node_modules'))
  const file = join(tree, 'outbound.ts')
  let pad = 0
  const deploy = (source: string) => writeFileSync(file, source + `// deploy ${'x'.repeat(++pad)}\n`)
  deploy(outbound)

  const state = join(home, 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [MONTY], pending: {},
    groups: { [GROUP]: { requireMention: true, allowFrom: [], threads: { '40': { requireMention: false } } } },
  }))
  const andonLog = join(home, 'andon.log')
  const andon = join(home, 'fleet-andon')
  writeFileSync(andon, `#!/bin/sh\necho "$*" >> '${andonLog}'\n`)
  chmodSync(andon, 0o755)
  const p = Bun.spawn(['bun', join(tree, 'server.ts')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TELEGRAM_STATE_DIR: state,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_ROOT: stub.url,
      TELEGRAM_TEE_DIR: join(home, 'tee'),
      TELEGRAM_HUDDLE_LINKS: join(home, 'no-links.json'),
      TAIL_FLEET_POSTS_BIN,
      TAIL_FLEET_POSTS_HOST: 'maxi',
      TAIL_FLEET_POSTS_DIR: join(home, 'tee'),
      TAIL_FLEET_POSTS_READ_MINI: `${TAIL_FLEET_POSTS_BIN} --dump ${join(home, 'tee')}`,
      PIN_INTERRUPT_BIN: '/usr/bin/true',
      ALERT_TAP_ANDON: andon,
      ALERT_TAP_LOG: join(home, 'alert-taps.jsonl'),
      PAGE_TOPICS_FILE: join(home, 'no-topics.json'),
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  cleanups.push(() => { p.kill('SIGKILL'); rmSync(join(tree, 'node_modules')) })
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
  const call = async (name: string, args: object) => {
    const mine = ++id
    send({ jsonrpc: '2.0', id: mine, method: 'tools/call', params: { name, arguments: args } })
    const res = await until(() => lines().find(m => m.id === mine))
    return res.result as { content: Array<{ text: string }>; isError?: boolean }
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'outbound-reload-test', version: '0' } } })
  await until(() => lines().find(m => m.id === 1), 20_000)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await until(() => err.includes(`polling as @${BOT}`), 20_000)
  return {
    call, deploy,
    events: () => lines().filter(m => m.method === 'notifications/claude/channel').map(m => m.params),
    andon: () => { try { return readFileSync(andonLog, 'utf8').split('\n').filter(Boolean) } catch { return [] } },
    /** True while the process that was started is the one still answering: nothing restarted it. */
    sameProcess: () => p.exitCode === null && err.split(`polling as @${BOT}`).length - 1 === 1,
    kill: () => p.kill('SIGKILL'),
  }
}

const RAISED = `--severity P2 --owner Grady --key ${reloadAlertKey(hostname().split('.')[0])} `
const RESOLVED = `--key ${reloadAlertKey(hostname().split('.')[0])} --resolve --owner Grady`
const linkOf = (body: Record<string, any>) => (body.entities ?? []).map((e: { url: string }) => e.url)

test('end to end: the DM refusal and an issue link go live in a running bridge by the file change alone', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, BEFORE)

  // Before the deploy: a reply into his DM goes out, and agents#1 is plain text.
  expect((await bridge.call('reply', { chat_id: MONTY, text: 'in your DM' })).isError).toBeUndefined()
  expect(stub.into(MONTY)).toEqual(['sendMessage'])
  expect((await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'see agents#1' })).isError).toBeUndefined()
  expect(linkOf(stub.of('sendMessage')[1].body)).toEqual([])

  bridge.deploy(REAL)

  // The next call, same process: the DM is refused and the issue is a link.
  const refused = await bridge.call('reply', { chat_id: MONTY, text: 'in your DM again' })
  expect(refused.isError).toBe(true)
  expect(refused.content[0].text).toBe(`reply failed: ${PRIVATE_CHAT_REFUSAL}`)
  expect(stub.into(MONTY)).toEqual(['sendMessage'])
  expect((await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'see agents#1' })).isError).toBeUndefined()
  expect(linkOf(stub.of('sendMessage')[2].body)).toEqual([ISSUE])
  // pin_message is not in outbound.ts, and its gate is: it is refused the DM too.
  expect((await bridge.call('pin_message', { chat_id: MONTY, message_id: '5000' })).content[0].text).toBe(`pin_message failed: ${PRIVATE_CHAT_REFUSAL}`)

  expect(bridge.sameProcess()).toBe(true)
  expect(bridge.andon()).toEqual([])
  bridge.kill()
})

test('end to end: a deploy with a syntax error, then one missing an export, keeps the bridge sending as before and raises one P2; a good deploy resolves it', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, REAL)
  const say = async () => {
    const r = await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'see agents#1' })
    expect(r.isError).toBeUndefined()
    return stub.of('sendMessage').at(-1)!.body
  }
  expect(linkOf(await say())).toEqual([ISSUE])

  bridge.deploy(REAL + '\nexport function broken( {\n')
  expect(linkOf(await say())).toEqual([ISSUE])
  expect(linkOf(await say())).toEqual([ISSUE])
  const raised = await until(() => bridge.andon().length > 0 && bridge.andon())
  expect(raised.length).toBe(1)
  expect(raised[0].startsWith(RAISED)).toBe(true)
  expect(raised[0]).toContain('is sending with the last version that loaded')

  bridge.deploy(without(REAL, 'export async function runReact(', 'async function runReact('))
  expect(linkOf(await say())).toEqual([ISSUE])
  // A good version with a visible difference: no links. It is taken, and the alert comes down.
  bridge.deploy(BEFORE)
  expect(linkOf(await say())).toEqual([])
  const after = await until(() => bridge.andon().length > 1 && bridge.andon())
  expect(after).toEqual([raised[0], RESOLVED])

  bridge.deploy(REAL)
  expect(linkOf(await say())).toEqual([ISSUE])
  expect(bridge.andon().length).toBe(2)
  expect(bridge.sameProcess()).toBe(true)
  bridge.kill()
})

test('end to end: a bridge launched on an outbound.ts that does not load still listens, posts nothing, says why, and sends from the first call after a good deploy', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, 'export const = \n')
  const raised = await until(() => bridge.andon().length > 0 && bridge.andon())
  expect(raised.length).toBe(1)
  expect(raised[0].startsWith(RAISED)).toBe(true)

  stub.push({ message: { message_id: 7000, date: 1, chat: { id: Number(GROUP), type: 'supergroup', title: 'Fleet', is_forum: true }, from: { id: Number(MONTY), is_bot: false, first_name: 'Monty', username: 'monty' }, message_thread_id: 40, is_topic_message: true, text: 'are you there?' } })
  await until(() => bridge.events().some(e => e.content === 'are you there?'))
  const r = await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'here' })
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toContain('reply failed: the bridge has no outbound rules loaded')
  expect((await bridge.call('list_pins', {})).isError).toBeUndefined()
  // Reads go on (the bridge looks up its own admin status); nothing is posted.
  expect(stub.into(GROUP).filter(m => !m.startsWith('get'))).toEqual([])

  bridge.deploy(REAL)
  expect((await bridge.call('reply', { chat_id: GROUP, message_thread_id: 40, text: 'here, see agents#1' })).isError).toBeUndefined()
  expect(linkOf(stub.of('sendMessage')[0].body)).toEqual([ISSUE])
  expect(await until(() => bridge.andon().length > 1 && bridge.andon())).toEqual([raised[0], RESOLVED])
  expect(bridge.sameProcess()).toBe(true)
  bridge.kill()
})
