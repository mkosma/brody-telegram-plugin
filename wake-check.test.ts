// wake-check.ts: SPEC-on-call-agents-wake-and-sleep-2026-11-09, "The wake check".
//
// The end-to-end tests run the real script as a subprocess against a stub Bot
// API on localhost, with HOME pointed at a temp dir, so no live state dir,
// token, access.json or post log is ever read or written. The token below is
// a fixture and reaches nothing but the stub.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Update } from 'grammy/types'
import { classifyUpdate, bridgeRunning, ACK_TEXT, EXIT, type ClassifyEnv, type PsRunner } from './wake-check.ts'
import { ALLOWED_UPDATES, inboundText, parseEnvFile, type GateAccess } from './inbound-gate.ts'

// The end-to-end tests spawn bun subprocesses, several in series; under the
// load of revert-proofs.py the default 5 s is not enough for one of them.
setDefaultTimeout(30_000)

const TOKEN = '123456:TEST-ONLY-fixture-token-never-live'
const BOT = 'MK_TestyBot'
const AGENT = 'Testy'
const GROUP_ID = -1004286764447
const MONTY = { id: 111, is_bot: false, first_name: 'Monty', username: 'monty' }
const STRANGER = { id: 999, is_bot: false, first_name: 'Eve', username: 'eve' }

const ACCESS: GateAccess = {
  dmPolicy: 'allowlist',
  allowFrom: ['111'],
  groups: { [String(GROUP_ID)]: { requireMention: true, allowFrom: [], threads: { '40': { requireMention: false } } } },
}

// --- update builders ---------------------------------------------------------

let nextId = 1000
type From = typeof MONTY
function dm(text: string, from: From = MONTY, extra: Record<string, unknown> = {}): Update {
  const id = nextId++
  return { update_id: id, message: { message_id: id, date: 0, chat: { id: from.id, type: 'private', first_name: from.first_name }, from, text, ...extra } } as unknown as Update
}
function grp(text: string | undefined, thread?: number, from: From = MONTY, extra: Record<string, unknown> = {}): Update {
  const id = nextId++
  return {
    update_id: id,
    message: {
      message_id: id, date: 0,
      chat: { id: GROUP_ID, type: 'supergroup', title: 'Fleet', is_forum: true },
      from,
      ...(text != null ? { text } : {}),
      ...(thread != null ? { message_thread_id: thread, is_topic_message: true } : {}),
      ...extra,
    },
  } as unknown as Update
}
const cmdEntity = (len: number) => ({ entities: [{ type: 'bot_command', offset: 0, length: len }] })

// --- the stub Bot API ----------------------------------------------------------

type Call = { method: string; body: Record<string, any> }
type Stub = {
  url: string
  calls: Call[]
  pending: Update[]
  getUpdatesError?: { status: number; error_code: number; description: string }
  stop: () => void
}

const stubs: Stub[] = []
afterAll(() => { for (const s of stubs) s.stop() })

function startStub(pending: Update[] = []): Stub {
  let sent = 5000
  const stub: Stub = { url: '', calls: [], pending: [...pending], stop: () => {} }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname)
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (!m || m[1] !== TOKEN) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
      const body = await req.json().catch(() => ({})) as Record<string, any>
      stub.calls.push({ method: m[2], body })
      switch (m[2]) {
        case 'getMe':
          return reply(200, { ok: true, result: { id: 42, is_bot: true, first_name: AGENT, username: BOT, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } })
        case 'getUpdates': {
          const e = stub.getUpdatesError
          if (e) return reply(e.status, { ok: false, error_code: e.error_code, description: e.description })
          // Telegram's semantics: an offset confirms every update below it.
          if (body.offset != null) stub.pending = stub.pending.filter(u => u.update_id >= body.offset)
          return reply(200, { ok: true, result: stub.pending.slice(0, body.limit ?? 100) })
        }
        case 'sendMessage':
          return reply(200, { ok: true, result: { message_id: sent++, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text, ...(body.message_thread_id != null ? { message_thread_id: body.message_thread_id } : {}) } })
      }
      return reply(400, { ok: false, error_code: 400, description: `Bad Request: no stub for ${m[2]}` })
    },
  })
  stub.url = `http://127.0.0.1:${server.port}`
  stub.stop = () => server.stop(true)
  stubs.push(stub)
  return stub
}

// --- fixture home and the subprocess -------------------------------------------

function fixture(access: object = ACCESS, envBody = `TELEGRAM_BOT_TOKEN=${TOKEN}\n`) {
  const home = mkdtempSync(join(tmpdir(), 'wake-check-'))
  const stateDir = join(home, '.claude', 'channels', 'telegram-testy')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, '.env'), envBody, { mode: 0o600 })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify(access))
  return {
    home,
    stateDir,
    teeFile: join(home, '.agents', 'telegram-tee', `${BOT}.jsonl`),
    ackFile: join(home, '.agents', AGENT, 'tmp', 'wake-ack.json'),
  }
}

async function runWake(home: string, apiRoot: string, args: string[] = [AGENT]) {
  const p = Bun.spawn(['bun', join(import.meta.dir, 'wake-check.ts'), ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, WAKE_CHECK_API_ROOT: apiRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const rc = await p.exited
  // Whatever happened, the token is never printed.
  expect(out + err).not.toContain(TOKEN)
  expect(out + err).not.toContain('TEST-ONLY')
  return { rc, out, err }
}

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const peeks = (s: Stub) => s.calls.filter(c => c.method === 'getUpdates')
const sends = (s: Stub) => s.calls.filter(c => c.method === 'sendMessage')

// --- every exit ------------------------------------------------------------------

test('wake check: nothing pending exits 0, and the peek is timeout 0 with no offset', async () => {
  const f = fixture()
  const stub = startStub()
  const r = await runWake(f.home, stub.url)
  expect(r.rc).toBe(EXIT.NOTHING)
  expect(peeks(stub).length).toBe(1)
  const body = peeks(stub)[0].body
  expect(body.timeout).toBe(0)
  expect(body.offset).toBeUndefined()
  expect(body.allowed_updates).toEqual([...ALLOWED_UPDATES])
  expect(sends(stub).length).toBe(0)
})

test('wake check: a DM from allowFrom exits 10, leaves it pending, and posts the ack in its chat', async () => {
  const f = fixture()
  const u = dm('are you up?')
  const stub = startStub([u])
  const r = await runWake(f.home, stub.url)
  expect(r.rc).toBe(EXIT.DELIVER)
  for (const c of peeks(stub)) expect(c.body.offset).toBeUndefined()
  expect(stub.pending.map(x => x.update_id)).toEqual([u.update_id])
  expect(sends(stub).map(c => [c.body.chat_id, c.body.text, c.body.message_thread_id])).toEqual([["111", ACK_TEXT, undefined]])
  expect(JSON.parse(readFileSync(f.ackFile, 'utf8')).update_id).toBe(u.update_id)
  // A DM is never written to the post log.
  expect(existsSync(f.teeFile)).toBe(false)
})

test('wake check: a failed peek exits 3, naming class and description, never the token', async () => {
  const f = fixture()
  const stub = startStub([dm('hello')])
  stub.getUpdatesError = { status: 401, error_code: 401, description: 'Unauthorized' }
  const r = await runWake(f.home, stub.url)
  expect(r.rc).toBe(EXIT.PEEK_FAILED)
  expect(r.err).toContain('GrammyError 401: Unauthorized')
  expect(sends(stub).length).toBe(0)

  // A network failure: nothing listens on port 9.
  const n = await runWake(f.home, 'http://127.0.0.1:9')
  expect(n.rc).toBe(EXIT.PEEK_FAILED)
  expect(n.err).toContain('HttpError')

  // No token in the channel env file.
  const g = fixture(ACCESS, 'TELEGRAM_ACCESS_MODE=static\n')
  const t = await runWake(g.home, stub.url)
  expect(t.rc).toBe(EXIT.PEEK_FAILED)
  expect(t.err).toContain('no TELEGRAM_BOT_TOKEN')

  // A bad name is usage, not a peek.
  expect((await runWake(f.home, stub.url, ['../etc'])).rc).toBe(EXIT.USAGE)
})

// --- drop and confirm --------------------------------------------------------------

test('wake check: chatter the bridge would drop is logged delivered:false and confirmed', async () => {
  const f = fixture()
  const chatter = [grp('lunch?', 39), grp('ok', 39, STRANGER), grp('see the doc', 39)]
  const stub = startStub([...chatter, dm('let me in', STRANGER)])
  const r = await runWake(f.home, stub.url)
  expect(r.rc).toBe(EXIT.NOTHING)
  expect(stub.pending).toEqual([])
  // The confirming call names the next id after the page, and only after it was read.
  expect(peeks(stub).map(c => c.body.offset)).toEqual([undefined, chatter[0].update_id + 4])
  const got = lines(f.teeFile)
  expect(got.map(l => l.text)).toEqual(['lunch?', 'ok', 'see the doc'])
  for (const l of got) {
    expect(l).toMatchObject({ dir: 'in', chat_id: String(GROUP_ID), thread_id: 39, delivered: false, bot: BOT })
  }
  expect(got.map(l => l.from_id)).toEqual(['111', '999', '111'])
  expect(sends(stub).length).toBe(0)
})

test('wake check: a mention behind a full 100-update page of chatter wakes the agent, in its own thread', async () => {
  const f = fixture()
  const chatter = Array.from({ length: 105 }, (_, i) => grp(`chatter ${i}`, 39))
  const mention = grp('@testy are you there', 39)
  const after = grp('after', 39)
  const stub = startStub([...chatter, mention, after])
  const r = await runWake(f.home, stub.url)
  expect(r.rc).toBe(EXIT.DELIVER)
  // Everything ahead of the mention is confirmed; the mention and what follows are not.
  expect(stub.pending.map(u => u.update_id)).toEqual([mention.update_id, after.update_id])
  const inbound = lines(f.teeFile).filter(l => l.dir === 'in')
  expect(inbound.length).toBe(105)
  expect(inbound.every(l => l.delivered === false)).toBe(true)
  expect(sends(stub).map(c => [c.body.chat_id, c.body.message_thread_id, c.body.text])).toEqual([[String(GROUP_ID), 39, ACK_TEXT]])
  // The ack is a group post of ours, so it is logged as the bridge logs one.
  expect(lines(f.teeFile).filter(l => l.dir === 'out').map(l => [l.text, l.thread_id])).toEqual([[ACK_TEXT, 39]])
})

// --- the dedupe ------------------------------------------------------------------------

test('wake check: the ack is posted once per wake (dedupe on update id)', async () => {
  const f = fixture()
  const first = dm('ping')
  const stub = startStub([first])
  expect((await runWake(f.home, stub.url)).rc).toBe(EXIT.DELIVER)
  expect((await runWake(f.home, stub.url)).rc).toBe(EXIT.DELIVER)
  expect(sends(stub).length).toBe(1)
  // A different deliverable update is a new wake, and is acknowledged.
  const second = dm('ping again')
  stub.pending = [second]
  expect((await runWake(f.home, stub.url)).rc).toBe(EXIT.DELIVER)
  expect(sends(stub).length).toBe(2)
  expect(JSON.parse(readFileSync(f.ackFile, 'utf8')).update_id).toBe(second.update_id)
})

// --- refuse while the bridge is up -----------------------------------------------------

async function fakeBridge(home: string, stateDir: string) {
  const dir = join(home, 'brody-telegram-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.ts'), 'await Bun.sleep(30_000)\n')
  const p = Bun.spawn(['bun', join(dir, 'server.ts')], { env: { PATH: process.env.PATH ?? '', TELEGRAM_STATE_DIR: stateDir } })
  for (let i = 0; i < 50 && bridgeRunning(stateDir) !== true; i++) await Bun.sleep(100)
  return p
}

test('wake check: refuses, touching no API, while a server.ts for this state dir runs', async () => {
  const f = fixture()
  const stub = startStub([dm('hello')])
  // The bridge's env names the dir in other casing: the fleet's casing does not agree.
  const bridge = await fakeBridge(f.home, f.stateDir.replace('telegram-testy', 'telegram-Testy'))
  try {
    const r = await runWake(f.home, stub.url)
    expect(r.rc).toBe(EXIT.REFUSED)
    expect(r.err).toContain('refused')
    expect(stub.calls.length).toBe(0)
  } finally {
    bridge.kill()
    await bridge.exited
  }
  // Once it is gone, the same check peeks.
  expect((await runWake(f.home, stub.url)).rc).toBe(EXIT.DELIVER)
})

test("wake check: another agent's bridge does not block this one", async () => {
  const f = fixture()
  const other = join(f.home, '.claude', 'channels', 'telegram-other')
  const stub = startStub()
  const bridge = await fakeBridge(f.home, other)
  try {
    expect((await runWake(f.home, stub.url)).rc).toBe(EXIT.NOTHING)
  } finally {
    bridge.kill()
    await bridge.exited
  }
})

test('bridge probe: case-blind match on TELEGRAM_STATE_DIR; a ps failure is unknown; its own pid never counts', () => {
  const dir = '/Users/x/.claude/channels/telegram-testy'
  const ps = (rows: Record<string, string>, fail = false): PsRunner => args => {
    if (fail) return { status: 1, stdout: '' }
    if (args[0] === '-axww') return { status: 0, stdout: Object.keys(rows).map(pid => `${pid} bun run /a/brody-telegram-plugin/server.ts`).join('\n') + '\n' }
    return { status: 0, stdout: `bun run /a/server.ts PATH=/bin ${rows[args[args.length - 1]]}\n` }
  }
  expect(bridgeRunning(dir, ps({ '10': 'TELEGRAM_STATE_DIR=/Users/x/.claude/channels/telegram-Testy' }), 1)).toBe(true)
  expect(bridgeRunning(dir, ps({ '10': 'TELEGRAM_STATE_DIR=/Users/x/.claude/channels/telegram-vera' }), 1)).toBe(false)
  expect(bridgeRunning(dir, ps({ '10': 'TELEGRAM_STATE_DIR=/Users/x/.claude/channels/telegram-testy' }), 10)).toBe(false)
  expect(bridgeRunning(dir, ps({}, true), 1)).toBe('unknown')
})

// --- the bridge's own decisions, update by update --------------------------------------

const ME = { id: 42, is_bot: true, first_name: AGENT, username: BOT, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } as ClassifyEnv['me']
const env = (access: GateAccess = ACCESS, isStatic = false): ClassifyEnv => ({ me: ME, access, agent: AGENT, isStatic })

test('wake classify: an open thread, a tag, a reply and @name deliver; untagged in a mention-only thread drops', () => {
  expect(classifyUpdate(grp('morning', 40), env()).action).toBe('deliver')
  const dropped = classifyUpdate(grp('morning', 39), env())
  expect(dropped.action).toBe('drop')
  expect(dropped.action === 'drop' && dropped.tee?.text).toBe('morning')
  expect(classifyUpdate(grp('hi @MK_TestyBot', 39, MONTY, { entities: [{ type: 'mention', offset: 3, length: 12 }] }), env()).action).toBe('deliver')
  expect(classifyUpdate(grp('yes', 39, MONTY, { reply_to_message: { message_id: 1, date: 0, chat: { id: GROUP_ID, type: 'supergroup' }, from: { id: 42, is_bot: true, first_name: AGENT, username: BOT } } }), env()).action).toBe('deliver')
  expect(classifyUpdate(grp('ok @testy', 39), env()).action).toBe('deliver')
  // A group this bot has no entry for drops, as gate() drops it.
  expect(classifyUpdate({ ...grp('@testy', 39), message: { ...(grp('@testy', 39) as any).message, chat: { id: -100777, type: 'supergroup', title: 'X' } } } as Update, env()).action).toBe('drop')
})

test('wake classify: an /invite or /excuse naming this agent delivers even where the gate would drop', () => {
  // Telegram's own /invite@<bot> form, in a group this bot has no entry for.
  const unknownGroup = (text: string, from: From = MONTY) => {
    const u = grp(text, 77, from) as any
    u.message.chat = { id: -100555, type: 'supergroup', title: 'New' }
    return u as Update
  }
  const inv = classifyUpdate(unknownGroup(`/invite@${BOT}`), env())
  expect(inv).toMatchObject({ action: 'deliver', why: 'invite', ack: { chat_id: '-100555', thread_id: 77 } })
  expect(classifyUpdate(grp('/excuse @testy', 40), env())).toMatchObject({ action: 'deliver', why: 'excuse' })
  // Naming another agent: the bridge ignores it and logs it delivered:false.
  const other = classifyUpdate(grp('/invite @vera', 39), env())
  expect(other).toMatchObject({ action: 'drop', why: 'command-not-mine' })
  expect(other.action === 'drop' && other.tee?.text).toBe('/invite @vera')
  // From someone outside allowFrom it is nothing, however it is addressed.
  expect(classifyUpdate(unknownGroup(`/invite@${BOT}`, STRANGER), env()).action).toBe('drop')
})

test("wake classify: a stranger's DM is a drop under every dmPolicy, and disabled drops Monty too", () => {
  const pairing: GateAccess = { ...ACCESS, dmPolicy: 'pairing' }
  expect(classifyUpdate(dm('hi', STRANGER), env(pairing))).toMatchObject({ action: 'drop', why: 'pairing' })
  expect(classifyUpdate(dm('hi', STRANGER), env())).toMatchObject({ action: 'drop', why: 'gate' })
  expect(classifyUpdate(dm('hi'), env(pairing)).action).toBe('deliver')
  expect(classifyUpdate(dm('hi'), env({ ...ACCESS, dmPolicy: 'disabled' })).action).toBe('drop')
})

test('wake classify: a reaction or a button tap from allowFrom delivers; from anyone else drops', () => {
  const tap = (from: From, data?: string) => ({
    update_id: nextId++,
    callback_query: {
      id: 'q', from, chat_instance: 'c', ...(data != null ? { data } : {}),
      message: { message_id: 5, date: 0, chat: { id: GROUP_ID, type: 'supergroup' }, message_thread_id: 39 },
    },
  }) as unknown as Update
  expect(classifyUpdate(tap(MONTY, 'ok:1'), env())).toMatchObject({ action: 'deliver', why: 'button', ack: { chat_id: String(GROUP_ID), thread_id: 39 } })
  expect(classifyUpdate(tap(STRANGER, 'ok:1'), env()).action).toBe('drop')
  expect(classifyUpdate(tap(MONTY), env()).action).toBe('drop')
  const react = (user: From) => ({
    update_id: nextId++,
    message_reaction: { chat: { id: GROUP_ID, type: 'supergroup' }, message_id: 5, user, date: 0, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] },
  }) as unknown as Update
  expect(classifyUpdate(react(MONTY), env())).toMatchObject({ action: 'deliver', why: 'reaction', ack: { chat_id: String(GROUP_ID) } })
  expect(classifyUpdate(react(STRANGER), env()).action).toBe('drop')
})

test('wake classify: /status in a DM from allowFrom delivers; a group /start is dropped and never logged', () => {
  expect(classifyUpdate(dm('/status', MONTY, cmdEntity(7)), env())).toMatchObject({ action: 'deliver', why: 'dm-command' })
  expect(classifyUpdate(dm('/status', STRANGER, cmdEntity(7)), env()).action).toBe('drop')
  const g = classifyUpdate(grp('/start', 40, MONTY, cmdEntity(6)), env())
  expect(g).toMatchObject({ action: 'drop', why: 'command' })
  expect(g.action === 'drop' && g.tee).toBeFalsy()
  // A command addressed to another bot is not ours: it falls through to the gate, as in grammy.
  expect(classifyUpdate(grp('/start@OtherBot', 40, MONTY, cmdEntity(15)), env()).action).toBe('deliver')
})

test('wake classify: kinds the bridge has no handler for are dropped and never logged', () => {
  const loc = classifyUpdate(grp(undefined, 40, MONTY, { location: { latitude: 0, longitude: 0 } }), env())
  expect(loc).toMatchObject({ action: 'drop', why: 'unhandled-kind' })
  expect(loc.action === 'drop' && loc.tee).toBeFalsy()
  const count = { update_id: nextId++, message_reaction_count: { chat: { id: GROUP_ID, type: 'supergroup' }, message_id: 1, date: 0, reactions: [] } } as unknown as Update
  expect(classifyUpdate(count, env())).toMatchObject({ action: 'drop', why: 'unhandled-update' })
})

// --- the shared pieces, and the server's use of them -------------------------------------

test('inbound text: each kind is logged under the text the bridge hands handleInbound', () => {
  expect(inboundText({ text: 'hi' })).toBe('hi')
  expect(inboundText({ photo: [], caption: 'cap' })).toBe('cap')
  expect(inboundText({ photo: [] })).toBe('(photo)')
  expect(inboundText({ document: { file_name: 'a<b>.pdf' } })).toBe('(document: a_b_.pdf)')
  expect(inboundText({ voice: {} })).toBe('(voice message)')
  expect(inboundText({ audio: { title: 'Song' } })).toBe('(audio: Song)')
  expect(inboundText({ audio: {} })).toBe('(audio: audio)')
  expect(inboundText({ video: {} })).toBe('(video)')
  expect(inboundText({ video_note: {}, caption: 'ignored' })).toBe('(video note)')
  expect(inboundText({ sticker: { emoji: '🎵' } })).toBe('(sticker 🎵)')
  expect(inboundText({})).toBeUndefined()
})

test('channel env file: KEY=VALUE lines, first occurrence wins', () => {
  expect(parseEnvFile('A=1\n# c\nB=x=y\nA=2\nbad line\n')).toEqual({ A: '1', B: 'x=y' })
})

test('server wiring: polls ALLOWED_UPDATES and takes every handler text from inboundText', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain('allowed_updates: [...ALLOWED_UPDATES],')
  expect(src.split('inboundText(ctx.message)!').length - 1).toBe(8)
  const wake = readFileSync(join(import.meta.dir, 'wake-check.ts'), 'utf8')
  expect(wake.split('allowed_updates: [...ALLOWED_UPDATES]').length - 1).toBe(2)
})
