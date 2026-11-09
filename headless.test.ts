/**
 * Headless mode (headless.ts), RULING-page-taps-need-a-poller-2026-11-09.
 *
 * The decision is tested pure. The process shape (who exits on stdin EOF, what
 * a 409 does) can only be tested on a real server.ts, so those tests spawn one
 * against a fake Bot API on localhost with a fake token and a temp
 * TELEGRAM_STATE_DIR. No real token, .env or Telegram is touched.
 */

import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isHeadless, headlessDecision, DmReplyLimiter, conflictSleepMs, servedHeadless,
  HEADLESS_DM_REPLY, HEADLESS_UNSERVED_TOAST, CONFLICT_SLEEP_DEFAULT_MS, DM_REPLY_EVERY_MS,
} from './headless.ts'

const MONTY = '1001'
const STRANGER = '2002'

// --- the pure decision ------------------------------------------------------

test('headless: only TELEGRAM_HEADLESS=1 turns it on', () => {
  expect(isHeadless({ TELEGRAM_HEADLESS: '1' })).toBe(true)
  for (const v of [undefined, '', '0', 'true', 'yes']) expect(isHeadless({ TELEGRAM_HEADLESS: v })).toBe(false)
})

test('headless: omf: and pg: taps pass to the existing handlers, from anyone', () => {
  const l = new DmReplyLimiter()
  for (const data of ['omf:0123abcd', 'pg:done:P0012', 'pg:later:P123456']) {
    for (const from of [MONTY, STRANGER]) {
      expect(headlessDecision({ callbackData: data, isCallback: true, isMessage: false, fromId: from }, [MONTY], l, 0))
        .toEqual({ kind: 'pass' })
    }
  }
})

test('headless: any other tap is answered, never passed and never left spinning', () => {
  const l = new DmReplyLimiter()
  for (const data of ['perm:allow:abcde', 'open:memex:x', 'omf:XYZ', 'pg:done:nope', 'anything', undefined]) {
    expect(headlessDecision({ callbackData: data, isCallback: true, isMessage: false, fromId: MONTY }, [MONTY], l, 0))
      .toEqual({ kind: 'refuse-tap', toast: HEADLESS_UNSERVED_TOAST })
    expect(headlessDecision({ callbackData: data, isCallback: true, isMessage: false, fromId: STRANGER }, [MONTY], l, 0))
      .toEqual({ kind: 'refuse-tap', toast: 'Not authorized.' })
  }
  expect(servedHeadless('omf:abc')).toBe(false)
})

test('headless: a DM from allowFrom gets the fixed reply once an hour per chat', () => {
  const l = new DmReplyLimiter()
  const dm = (from: string, now: number) =>
    headlessDecision({ isCallback: false, isMessage: true, chatType: 'private', fromId: from }, [MONTY, '3003'], l, now)
  expect(dm(MONTY, 0)).toEqual({ kind: 'dm-reply', text: HEADLESS_DM_REPLY })
  expect(dm(MONTY, 1000).kind).toBe('drop')
  expect(dm(MONTY, DM_REPLY_EVERY_MS - 1).kind).toBe('drop')
  expect(dm('3003', 1000).kind).toBe('dm-reply')
  expect(dm(MONTY, DM_REPLY_EVERY_MS).kind).toBe('dm-reply')
  expect(HEADLESS_DM_REPLY).toBe("Page doesn't read messages. Tap a button, or talk to Vera.")
})

test('headless: a stranger DM, a group post and a reaction are dropped', () => {
  const l = new DmReplyLimiter()
  expect(headlessDecision({ isCallback: false, isMessage: true, chatType: 'private', fromId: STRANGER }, [MONTY], l, 0).kind).toBe('drop')
  expect(headlessDecision({ isCallback: false, isMessage: true, chatType: 'supergroup', fromId: MONTY }, [MONTY], l, 0).kind).toBe('drop')
  expect(headlessDecision({ isCallback: false, isMessage: false, chatType: 'private', fromId: MONTY }, [MONTY], l, 0).kind).toBe('drop')
  // None of those spent Monty's reply.
  expect(headlessDecision({ isCallback: false, isMessage: true, chatType: 'private', fromId: MONTY }, [MONTY], l, 0).kind).toBe('dm-reply')
})

test('headless: the 409 sleep defaults long and takes a test override', () => {
  expect(conflictSleepMs({})).toBe(CONFLICT_SLEEP_DEFAULT_MS)
  expect(CONFLICT_SLEEP_DEFAULT_MS).toBeGreaterThanOrEqual(60_000)
  expect(conflictSleepMs({ TELEGRAM_CONFLICT_SLEEP_MS: '500' })).toBe(500)
  expect(conflictSleepMs({ TELEGRAM_CONFLICT_SLEEP_MS: 'x' })).toBe(CONFLICT_SLEEP_DEFAULT_MS)
  expect(conflictSleepMs({ TELEGRAM_CONFLICT_SLEEP_MS: '' })).toBe(CONFLICT_SLEEP_DEFAULT_MS)
})

// --- a real server.ts against a fake Bot API --------------------------------

const FAKE_TOKEN = '123456:FAKE-TOKEN-FOR-DRILLS'

type Call = { method: string; body: any }

function fakeApi(opts: { conflict?: boolean; updates?: any[] } = {}) {
  const calls: Call[] = []
  let queue = [...(opts.updates ?? [])]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const method = url.pathname.split('/').pop()!
      let body: any = {}
      try { body = await req.json() } catch {}
      calls.push({ method, body })
      const ok = (result: unknown) => Response.json({ ok: true, result })
      switch (method) {
        case 'getMe':
          return ok({ id: 42, is_bot: true, first_name: 'Fake', username: 'FakePageBot' })
        case 'getUpdates': {
          if (opts.conflict) {
            return Response.json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, { status: 409 })
          }
          if (queue.length) { const u = queue; queue = []; return ok(u) }
          await Bun.sleep(150)
          return ok([])
        }
        case 'sendMessage':
          return ok({ message_id: 900 + calls.length, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text })
        default:
          return ok(true)
      }
    },
  })
  return { calls, server, root: `http://127.0.0.1:${server.port}` }
}

type Spawned = { proc: ReturnType<typeof Bun.spawn>; dir: string; stderr: () => Promise<string> }
const live: Array<{ s: Spawned; api: ReturnType<typeof fakeApi> }> = []

afterEach(() => {
  for (const { s, api } of live.splice(0)) {
    try { s.proc.kill('SIGKILL') } catch {}
    api.server.stop(true)
    rmSync(s.dir, { recursive: true, force: true })
  }
})

function spawnBridge(api: ReturnType<typeof fakeApi>, env: Record<string, string>): Spawned {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-headless-'))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [MONTY], groups: {}, pending: {} }))
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: dir,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      TELEGRAM_STATE_DIR: dir,
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_API_ROOT: api.root,
      TELEGRAM_TEE_DIR: join(dir, 'tee'),
      TELEGRAM_PHRASES_ROOT: join(dir, 'phrases'),
      ...env,
    },
  })
  const s: Spawned = { proc, dir, stderr: () => new Response(proc.stderr as ReadableStream).text() }
  live.push({ s, api })
  return s
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await Bun.sleep(50)
  }
  return cond()
}

const exitedWithin = (p: ReturnType<typeof Bun.spawn>, ms: number) =>
  Promise.race([p.exited.then(() => true), Bun.sleep(ms).then(() => false)])

test('headless bridge: stdin EOF does not end it; it keeps polling and exits 0 on SIGTERM', async () => {
  const api = fakeApi()
  const b = spawnBridge(api, { TELEGRAM_HEADLESS: '1' })
  expect(await until(() => existsSync(join(b.dir, 'poll.heartbeat')), 5000)).toBe(true)
  expect(readFileSync(join(b.dir, 'bot.pid'), 'utf8')).toBe(String(b.proc.pid))
  ;(b.proc.stdin as any).end()
  // Past one orphan-watchdog interval (5s): an agent-mode bridge is gone by now.
  expect(await exitedWithin(b.proc, 6500)).toBe(false)
  const polls = api.calls.filter(c => c.method === 'getUpdates').length
  await Bun.sleep(400)
  expect(api.calls.filter(c => c.method === 'getUpdates').length).toBeGreaterThan(polls)
  b.proc.kill('SIGTERM')
  expect(await exitedWithin(b.proc, 4000)).toBe(true)
  expect(b.proc.exitCode).toBe(0)
  expect(existsSync(join(b.dir, 'bot.pid'))).toBe(false)
  // Headless sets no command menu: its commands would advertise a session.
  expect(api.calls.some(c => c.method === 'setMyCommands')).toBe(false)
}, 20000)

test('agent-mode bridge: stdin EOF ends it, exit 0', async () => {
  const api = fakeApi()
  const b = spawnBridge(api, {})
  expect(await until(() => existsSync(join(b.dir, 'poll.heartbeat')), 5000)).toBe(true)
  ;(b.proc.stdin as any).end()
  expect(await exitedWithin(b.proc, 4000)).toBe(true)
  expect(b.proc.exitCode).toBe(0)
  expect(await b.stderr()).toContain('telegram channel: shutting down')
  expect(api.calls.some(c => c.method === 'setMyCommands')).toBe(true)
}, 20000)

test('headless bridge: taps reach the existing handlers, a DM gets one fixed reply, the rest is dropped', async () => {
  const msg = (id: number, from: string, chatType: string, text: string) => ({
    update_id: id,
    message: { message_id: id, date: 0, text, from: { id: Number(from), is_bot: false, first_name: 'x' },
      chat: chatType === 'private' ? { id: Number(from), type: 'private' } : { id: -100777, type: chatType, title: 'G' } },
  })
  const tap = (id: number, from: string, data: string) => ({
    update_id: id,
    callback_query: { id: `cq${id}`, chat_instance: 'ci', data, from: { id: Number(from), is_bot: false, first_name: 'x' },
      message: { message_id: 5, date: 0, chat: { id: Number(from), type: 'private' }, text: 't' } },
  })
  const api = fakeApi({ updates: [
    msg(1, MONTY, 'private', 'hello'),
    msg(2, MONTY, 'private', 'again'),
    msg(3, STRANGER, 'private', 'let me in'),
    msg(4, MONTY, 'supergroup', 'group chatter'),
    // pg: from a stranger: the existing pg: handler's own gate answers it, and
    // nothing is run. (A tap from allowFrom would run the real interrupt.)
    tap(5, STRANGER, 'pg:done:P0001'),
    // omf: with an id no store holds: the existing omf: handler answers it.
    tap(6, MONTY, 'omf:00000000deadbeef'),
    tap(7, MONTY, 'some-agent-button'),
    tap(8, STRANGER, 'some-agent-button'),
  ] })
  const b = spawnBridge(api, { TELEGRAM_HEADLESS: '1' })
  const answers = () => api.calls.filter(c => c.method === 'answerCallbackQuery')
  expect(await until(() => answers().length >= 4, 8000)).toBe(true)
  await Bun.sleep(300)

  const sends = api.calls.filter(c => c.method === 'sendMessage')
  expect(sends.map(c => [String(c.body.chat_id), c.body.text])).toEqual([[MONTY, HEADLESS_DM_REPLY]])

  const toast = (id: string) => answers().find(c => c.body.callback_query_id === id)?.body.text
  expect(toast('cq5')).toBe('Not authorized.')
  expect(toast('cq6')).toBe('That link has expired.')
  expect(toast('cq7')).toBe(HEADLESS_UNSERVED_TOAST)
  expect(toast('cq8')).toBe('Not authorized.')
  expect(answers().length).toBe(4)

  // The stranger was not paired: headless never writes a pending code.
  expect(JSON.parse(readFileSync(join(b.dir, 'access.json'), 'utf8')).pending).toEqual({})
  // Nothing was written to stdout: there is no MCP peer to write to.
  b.proc.kill('SIGTERM')
  await b.proc.exited
  expect(await new Response(b.proc.stdout as ReadableStream).text()).toBe('')
}, 20000)

test('headless bridge: a 409 is logged once, never retried, and exits 0 after the sleep', async () => {
  const api = fakeApi({ conflict: true })
  const t0 = Date.now()
  const b = spawnBridge(api, { TELEGRAM_HEADLESS: '1', TELEGRAM_CONFLICT_SLEEP_MS: '1500' })
  expect(await exitedWithin(b.proc, 8000)).toBe(true)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1500)
  expect(b.proc.exitCode).toBe(0)
  expect(api.calls.filter(c => c.method === 'getUpdates').length).toBe(1)
  const err = await b.stderr()
  expect(err).toContain('409 Conflict - another poller holds this token')
  expect(err).not.toContain(FAKE_TOKEN)
}, 20000)
