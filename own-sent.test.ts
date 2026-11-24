// BRIEF-reactions-reach-only-the-poster-2026-11-24: a reaction in a group is
// handed to the session only when this bot sent the message or holds it as a
// pin; a private chat's always is. Anything else is one post-log line.
//
// The unit tests drive own-sent.ts. The end-to-end tests run the real
// server.ts as a subprocess: the test is its MCP client over stdio, a local
// stub stands in for the Telegram API and delivers the reaction updates, and
// small scripts stand in for monty-reactions, fleet-andon and dispatch.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnSent, reactionIsOurs, notOursEntry, OWN_SENT_MAX, OWN_SENT_MAX_AGE_MS } from './own-sent.ts'
import { outEntry } from './post-log.ts'

setDefaultTimeout(30_000)

const GROUP = '-1004286764447'
const BOT = 'MK_TestyBot'
const NOW = new Date('2026-11-24T03:00:00.000Z')

const outLine = (message_id: number, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, dir: 'out', chat_id: GROUP, thread_id: 40, message_id, reply_to: null, text: 't', edit: false, bot: BOT, ...extra })
const enoent = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) }
const reader = (files: Record<string, string>) => (f: string) => (f in files ? files[f] : enoent())
const seedWith = (own: OwnSent, files: Record<string, string>) => {
  const errs: string[] = []
  const ok = own.seed({ dir: '/tee', bot: BOT, read: reader(files), now: () => NOW, stderr: s => errs.push(s) })
  return { ok, errs }
}

// --- which reactions are ours -----------------------------------------------------

test('own sent: a reaction on a message this bot sent is ours, and one on a peer\'s message is not', () => {
  const own = new OwnSent()
  expect(seedWith(own, { [`/tee/${BOT}.jsonl`]: outLine(2001, '2026-11-23T20:00:00.000Z') + '\n' }).ok).toBe(true)
  const deps = { own, pins: () => [] }
  expect(reactionIsOurs(deps, GROUP, 2001)).toBe('own-sent')
  expect(reactionIsOurs(deps, GROUP, 2420)).toBeUndefined()
  // The same message id in another chat is another message.
  expect(reactionIsOurs(deps, '-1009999999999', 2001)).toBeUndefined()
})

test('own sent: a private chat\'s reaction is always ours, seeded or not', () => {
  const deps = { own: new OwnSent(), pins: () => [] }
  expect(reactionIsOurs(deps, '6324582303', 5)).toBe('private')
  seedWith(deps.own, {})
  expect(reactionIsOurs(deps, '6324582303', 5)).toBe('private')
})

test('own sent: a reaction on a pin this bot holds is ours, though the message is not in the set', () => {
  const own = new OwnSent()
  seedWith(own, {})
  const deps = { own, pins: () => [{ chat_id: GROUP, message_id: 900 }] }
  expect(reactionIsOurs(deps, GROUP, 900)).toBe('pin')
  expect(reactionIsOurs(deps, GROUP, 901)).toBeUndefined()
  // A pin record that throws is no pins, never a throw into the handler.
  expect(reactionIsOurs({ own, pins: () => { throw new Error('unreadable') } }, GROUP, 900)).toBeUndefined()
})

test('own sent: the set grows on send, through the post log\'s own out line', () => {
  const own = new OwnSent()
  seedWith(own, {})
  const written: Array<Record<string, unknown>> = []
  const tee = own.wrap(e => { written.push(e) })
  expect(own.has(GROUP, 3001)).toBe(false)
  tee(outEntry({ chat_id: GROUP, thread_id: 40, message_id: 3001, text: 'sent after startup', edit: false }))
  expect(own.has(GROUP, 3001)).toBe(true)
  // The line still reaches the log, and an inbound line is not a send.
  tee({ ts: 'x', dir: 'in', chat_id: GROUP, message_id: 3002, text: 'his' })
  expect(written.map(e => e.message_id)).toEqual([3001, 3002])
  expect(own.has(GROUP, 3002)).toBe(false)
  // A write that fails still counts: the message went out.
  const failing = own.wrap(() => { throw new Error('disk full') })
  expect(() => failing(outEntry({ chat_id: GROUP, message_id: 3003, text: 't', edit: false }))).toThrow('disk full')
  expect(own.has(GROUP, 3003)).toBe(true)
})

// --- the seed ---------------------------------------------------------------------

test('own sent: the seed skips a record older than 7 days', () => {
  const own = new OwnSent()
  const old = new Date(NOW.getTime() - OWN_SENT_MAX_AGE_MS - 1000).toISOString()
  const edge = new Date(NOW.getTime() - OWN_SENT_MAX_AGE_MS + 1000).toISOString()
  expect(OWN_SENT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  const { ok, errs } = seedWith(own, { [`/tee/${BOT}.jsonl`]: [outLine(1, old), outLine(2, edge), outLine(3, 'not a date')].join('\n') + '\n' })
  expect(ok).toBe(true)
  expect(errs).toEqual([])
  expect([own.has(GROUP, 1), own.has(GROUP, 2), own.has(GROUP, 3)]).toEqual([false, true, false])
  expect(own.size).toBe(1)
})

test('own sent: the seed keeps only the latest out records, across the rotated file and the current one', () => {
  expect(OWN_SENT_MAX).toBe(10_000)
  const own = new OwnSent(3)
  const ts = '2026-11-23T20:00:00.000Z'
  seedWith(own, {
    [`/tee/${BOT}.jsonl.1`]: [outLine(1, ts), outLine(2, ts)].join('\n') + '\n',
    [`/tee/${BOT}.jsonl`]: [outLine(3, ts), outLine(4, ts), outLine(5, ts)].join('\n') + '\n',
  })
  expect([1, 2, 3, 4, 5].map(id => own.has(GROUP, id))).toEqual([false, false, true, true, true])
  // The set keeps to its bound as it grows, dropping the oldest.
  own.note(GROUP, 6)
  expect([3, 4, 5, 6].map(id => own.has(GROUP, id))).toEqual([false, true, true, true])
})

test('own sent: the seed takes only this bot\'s out records, and survives a line that is not JSON', () => {
  const own = new OwnSent()
  const ts = '2026-11-23T20:00:00.000Z'
  const { ok } = seedWith(own, { [`/tee/${BOT}.jsonl`]: [
    outLine(10, ts),
    '{"dir":"out", truncated',
    JSON.stringify({ ts, dir: 'in', chat_id: GROUP, message_id: 11, from_user: 'MK_MayaBot', from_is_bot: true, text: 'peer', delivered: true, bot: BOT }),
    outLine(12, ts, { bot: 'MK_MayaBot' }),
    outLine(13, ts, { edit: true }),
    outLine(14, ts, { message_id: null }),
  ].join('\n') + '\n' })
  expect(ok).toBe(true)
  expect([10, 11, 12, 13].map(id => own.has(GROUP, id))).toEqual([true, false, false, true])
  expect(own.size).toBe(2)
})

test('own sent: a seed keeps what was sent before it ran, and no post log at all is a bot that has sent nothing', () => {
  const own = new OwnSent()
  own.note(GROUP, 50)
  const { ok, errs } = seedWith(own, {})
  expect(ok).toBe(true)
  expect(errs).toEqual([])
  expect(own.seeded).toBe(true)
  expect(own.has(GROUP, 50)).toBe(true)
  expect(reactionIsOurs({ own, pins: () => [] }, GROUP, 51)).toBeUndefined()
})

test('own sent: an unreadable post log delivers everything and says so in one line', () => {
  const own = new OwnSent()
  const errs: string[] = []
  const ok = own.seed({
    dir: '/tee', bot: BOT, now: () => NOW, stderr: s => errs.push(s),
    read: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
  })
  expect(ok).toBe(false)
  expect(own.seeded).toBe(false)
  expect(errs).toEqual(['telegram channel: own post log unreadable, so every reaction goes to the session: Error: EACCES: permission denied\n'])
  const deps = { own, pins: () => [] }
  expect(reactionIsOurs(deps, GROUP, 2420)).toBe('unseeded')
  // Before any seed has run the answer is the same: deliver.
  expect(reactionIsOurs({ own: new OwnSent(), pins: () => [] }, GROUP, 2420)).toBe('unseeded')
})

test('own sent: the not-ours line is not one a reader of the log takes for a post of his', () => {
  const e = notOursEntry({ chat_id: GROUP, message_id: 2420, emoji: '🔥', action: 'added', user_id: '111', ts: '2026-11-24T02:40:00.000Z' })
  expect(e).toEqual({
    ts: expect.any(String), dir: 'in', type: 'reaction', chat_id: GROUP, reaction_to: 2420, emoji: '🔥', action: 'added',
    user_id: '111', reacted_at: '2026-11-24T02:40:00.000Z', delivered: false, reason: 'not-ours',
  })
  for (const k of ['message_id', 'from_id', 'from_user', 'from_is_bot', 'text']) expect(k in e).toBe(false)
})

test('own sent: the server asks before the loop, and gates only the session hand-off', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const start = src.indexOf("bot.on('message_reaction'")
  const body = src.slice(start, src.indexOf("bot.on('message:text'"))
  const asked = body.indexOf('const ours = reactionIsOurs({ own: ownSent, pins: () => pinDeps.store.load() }, chat_id, msgId)')
  const gate = body.indexOf('if (!ours) {')
  expect(asked).toBeGreaterThan(-1)
  // Before the loop: his thumbs-up starts the pin's release inside it.
  expect(asked).toBeLessThan(body.indexOf('for (const { emoji, action } of events) {'))
  // After everything that must run for every reaction, before the session.
  for (const ran of ["answered(userId, chat_id, msgId, 'thumbs-up')", 'void logMontyReaction(', 'void logAlertReaction(', 'if (await handleThumbsDown(']) {
    expect(body.indexOf(ran)).toBeGreaterThan(-1)
    expect(body.indexOf(ran)).toBeLessThan(gate)
  }
  expect(gate).toBeLessThan(body.indexOf('mcp.notification({'))
  // Every out line the bridge writes goes through the one wrapped tee.
  expect(src).toContain('const tee = ownSent.wrap(makeTee({ dir: TEE_DIR, bot: () => botUsername }))')
  expect(src.match(/makeTee\(/g)?.length).toBe(1)
  // Seeded from this host's own post log, once the bot knows its name.
  expect(src).toContain('ownSent.seed({ dir: TEE_DIR, bot: info.username, stderr: s => process.stderr.write(s) })')
  expect(readFileSync(join(import.meta.dir, 'own-sent.ts'), 'utf8')).not.toContain('tail-fleet-posts')
})

// --- end to end -------------------------------------------------------------------

const TOKEN = '123456:TEST-ONLY-fixture-token-never-live'
const MONTY = 111
const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups) c() })

async function until<T>(probe: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > end) throw new Error(`condition not met within ${ms}ms`)
    await Bun.sleep(25)
  }
}

function startStub() {
  const queue: object[] = []
  let update_id = 1000
  let message_id = 8000
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname)
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (!m || m[1] !== TOKEN) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
      switch (m[2]) {
        case 'getMe':
          return reply(200, { ok: true, result: { id: 42, is_bot: true, first_name: 'Testy', username: BOT, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } })
        case 'getUpdates':
          if (!queue.length) await Bun.sleep(100)
          return reply(200, { ok: true, result: queue.splice(0) })
        case 'sendMessage':
          return reply(200, { ok: true, result: { message_id: ++message_id, date: 0, chat: { id: Number(GROUP), type: 'supergroup' }, text: '' } })
        case 'getChatMember':
          return reply(200, { ok: true, result: { status: 'administrator', user: { id: 42, is_bot: true, first_name: 'Testy' } } })
      }
      return reply(200, { ok: true, result: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    lastSent: () => message_id,
    react: (chat: { id: number; type: string }, mid: number, emoji: string) => {
      queue.push({ update_id: ++update_id, message_reaction: {
        chat, message_id: mid, date: 1795487000, user: { id: MONTY, is_bot: false, first_name: 'Monty', username: 'Monty' },
        old_reaction: [], new_reaction: [{ type: 'emoji', emoji }],
      } })
    },
  }
}

const script = (file: string, body: string) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755) }

function startBridge(apiRoot: string, prepare: (home: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'own-sent-'))
  const state = join(home, 'telegram-testy')
  mkdirSync(state)
  mkdirSync(join(home, 'bin'))
  mkdirSync(join(home, 'tee'))
  writeFileSync(join(state, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [String(MONTY)], pending: {},
    groups: { [GROUP]: { requireMention: false, allowFrom: [] } },
  }))
  // Page's topics, owned here by this bridge's agent so its alert paths run.
  writeFileSync(join(home, 'topics.json'), JSON.stringify({
    chat_id: GROUP, owner: 'Testy', topics: { p0_alerts: { thread_id: 1670 }, fleet_notifications: { thread_id: 1671 } },
  }))
  // monty-reactions --append: keep the line it was handed.
  script(join(home, 'bin', 'monty-reactions'), `cat >> "${join(home, 'reactions.jsonl')}"`)
  // fleet-andon --message-info: message 7777 is an alert, nothing else is.
  script(join(home, 'bin', 'fleet-andon'), [
    `echo "$*" >> "${join(home, 'andon.calls')}"`,
    `case "$*" in *"--message-id 7777"*) echo '{"found":true,"key":"drill:alert@maxi","text":"Drill alert (maxi)","topic":"p0_alerts","host":"maxi"}';; *) echo '{"found":false}';; esac`,
  ].join('\n'))
  script(join(home, 'bin', 'dispatch'), `echo "$*" >> "${join(home, 'dispatch.calls')}"; cat > /dev/null`)
  // No peer posts: this bridge reads no other bot's log here.
  script(join(home, 'bin', 'tail-fleet-posts'), 'exit 0')
  prepare(home)
  const p = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: {
      PATH: `${join(home, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      AGENT_CLASS: 'Testy',
      TELEGRAM_STATE_DIR: state,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_ROOT: apiRoot,
      TELEGRAM_TEE_DIR: join(home, 'tee'),
      MONTY_REACTIONS_BIN: join(home, 'bin', 'monty-reactions'),
      ALERT_TAP_ANDON: join(home, 'bin', 'fleet-andon'),
      ALERT_TAP_LOG: join(home, 'alert-taps.jsonl'),
      PAGE_TOPICS_FILE: join(home, 'topics.json'),
      TAIL_FLEET_POSTS_BIN: join(home, 'bin', 'tail-fleet-posts'),
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
  const messages = () => out.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const lines = (file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), 'utf8').trim().split('\n').filter(Boolean) : [])
  const send = (msg: object) => { p.stdin.write(JSON.stringify(msg) + '\n'); p.stdin.flush() }
  return {
    home,
    stderr: () => err,
    send,
    response: (id: number) => until(() => messages().find(m => m.id === id)),
    reactions: () => messages().filter(m => m.method === 'notifications/claude/channel' && m.params.meta?.type === 'reaction').map(m => `${m.params.meta.message_id}:${m.params.meta.reaction}`),
    lines,
    json: (file: string) => lines(file).map(l => JSON.parse(l)),
    tee: () => lines(join('tee', `${BOT}.jsonl`)).map(l => JSON.parse(l)),
    start: async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'own-sent-test', version: '0' } } })
      await until(() => messages().find(m => m.id === 1))
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      await until(() => err.includes(`polling as @${BOT}`))
    },
    kill: () => p.kill('SIGKILL'),
  }
}

const SUPER = { id: Number(GROUP), type: 'supergroup' }
const DM = { id: MONTY, type: 'private' }

test('reactions, end to end: only a reaction on this bot\'s own message, a held pin or a private chat reaches the session', async () => {
  const stub = startStub()
  const bridge = startBridge(stub.url, home => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    // Sent by this bot an hour ago (2001), and eight days ago (1001).
    writeFileSync(join(home, 'tee', `${BOT}.jsonl`), [outLine(1001, old), outLine(2001, recent)].join('\n') + '\n')
    // A pin held from an earlier session, on a message older than the seed's bound.
    writeFileSync(join(home, 'telegram-testy', 'pins.json'), JSON.stringify({ pins: [
      { chat_id: GROUP, message_id: 900, thread_id: 40, text: 'Ship it?', pinned_at: new Date(Date.now() - 3600_000).toISOString() },
    ] }))
  })
  await bridge.start()

  // A message sent after startup: the set grows on send.
  bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: GROUP, text: 'sent after startup', message_thread_id: '40' } } })
  const replied = await bridge.response(2)
  expect(replied.result.isError).toBeFalsy()
  const sentId = stub.lastSent()

  stub.react(SUPER, 2420, '🔥')   // a peer's now-playing post
  stub.react(SUPER, 1001, '🤔')   // ours, but older than the seed reads
  stub.react(SUPER, 2001, '👏')   // ours, seeded
  stub.react(SUPER, sentId, '🎉') // ours, sent this session
  stub.react(SUPER, 900, '❤')     // a pin this bot holds
  stub.react(DM, 55, '👌')        // a private chat
  await until(() => bridge.reactions().includes('55:👌'))
  expect(bridge.reactions()).toEqual(['2001:👏', `${sentId}:🎉`, '900:❤', '55:👌'])

  // The two that were not ours are one post-log line each, and nothing on stderr.
  const notOurs = bridge.tee().filter(l => l.type === 'reaction')
  expect(notOurs).toEqual([2420, 1001].map((id, i) => ({
    ts: expect.any(String), dir: 'in', type: 'reaction', chat_id: GROUP, reaction_to: id, emoji: ['🔥', '🤔'][i], action: 'added',
    user_id: String(MONTY), reacted_at: new Date(1795487000 * 1000).toISOString(), delivered: false, reason: 'not-ours', bot: BOT,
  })))
  expect(bridge.stderr()).not.toContain('not-ours')
  expect(bridge.stderr()).not.toContain('own post log unreadable')
  // Every group reaction went to the reaction log, delivered to the session or not.
  await until(() => bridge.json('reactions.jsonl').length === 5)
  expect(bridge.json('reactions.jsonl').map(l => l.message_id).sort()).toEqual([1001, 2001, 2420, 900, sentId].sort())
  bridge.kill()
})

test('reactions, end to end: the reaction log, the alert log and the thumbs-down hand-off all run for a reaction that is not ours', async () => {
  const stub = startStub()
  const bridge = startBridge(stub.url)
  await bridge.start()

  // 7777 is an alert in Page's P0 topic, posted by fleet-andon and so in no
  // out record of this bot's: not ours.
  stub.react(SUPER, 7777, '👍')
  stub.react(SUPER, 7777, '👎')
  // Ordinary and ours-by-chat, as the marker that the two above were handled.
  stub.react(DM, 56, '👌')
  await until(() => bridge.reactions().includes('56:👌'))
  await until(() => bridge.lines('dispatch.calls').length === 1 && bridge.json('alert-taps.jsonl').length === 3 && bridge.json('reactions.jsonl').length === 2)

  // logMontyReaction: both, through monty-reactions --append.
  // Neither append is awaited, so the two lines land in either order.
  expect(bridge.json('reactions.jsonl').map(l => [l.message_id, l.emoji, l.action, l.bot, l.agent]).sort()).toEqual([
    [7777, '👍', 'added', BOT, 'Testy'], [7777, '👎', 'added', BOT, 'Testy'],
  ].sort())
  // logAlertReaction: both, in the tap log with the alert's key.
  const taps = bridge.json('alert-taps.jsonl')
  expect(taps.filter(l => l.kind === 'reaction').map(l => [l.key, l.button]).sort()).toEqual([
    ['drill:alert@maxi', 'reaction:👍'], ['drill:alert@maxi', 'reaction:👎'],
  ])
  // handleThumbsDown: one dispatch to Grady, and its own tap-log line.
  expect(bridge.lines('dispatch.calls')).toEqual([expect.stringContaining('send --to agent:Grady --from Testy')])
  expect(taps.filter(l => l.kind === 'thumbs-down').map(l => [l.key, l.ok])).toEqual([['drill:alert@maxi', true]])
  // The session was handed neither. The thumbs-up is a not-ours line; the
  // thumbs-down was the hand-off's, as before, and is not logged twice.
  expect(bridge.reactions()).toEqual(['56:👌'])
  expect(bridge.tee().filter(l => l.type === 'reaction').map(l => [l.reaction_to, l.emoji, l.reason])).toEqual([[7777, '👍', 'not-ours']])
  bridge.kill()
})

test('reactions, end to end: an unreadable post log delivers every reaction and says so once at startup', async () => {
  const stub = startStub()
  const bridge = startBridge(stub.url, home => {
    // The bot's own log is a directory: it cannot be read, or appended to.
    mkdirSync(join(home, 'tee', `${BOT}.jsonl`))
  })
  await bridge.start()
  stub.react(SUPER, 2420, '🔥')
  stub.react(SUPER, 2421, '👏')
  await until(() => bridge.reactions().length === 2)
  expect(bridge.reactions()).toEqual(['2420:🔥', '2421:👏'])
  expect(bridge.stderr().split('\n').filter(l => l.includes('own post log unreadable')).length).toBe(1)
  bridge.kill()
})
