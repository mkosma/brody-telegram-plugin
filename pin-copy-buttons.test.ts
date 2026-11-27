// Pins, copy buttons and button state (Monty, 2026-11-21, Telegram msgs 1816
// and 1855; design: Grady). Each test below has a revert in revert-proofs.py
// (ids PN*, CP*, BS*).
//
// Nothing here reaches Telegram, Monty or a live queue. The unit tests hand
// the code a stub API and a temp record; the end-to-end tests run the real
// server.ts as a subprocess under a temp HOME, with a local stub standing in
// for the Bot API and stub commands for interrupt and fleet-andon.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SentPosts, filePinStore, notAQuestion, runPinMessage, runUnpinMessage, runListPins, releaseOnAnswer, sweepPins,
  INTERRUPT_BIN, PIN_AGE_MS, PIN_QUESTION_MAX, type Pin, type PinApi, type PinDeps, type SweepDeps,
} from './pin.ts'
import { chosenKeyboard, markTapped, frozenToast, showsOrOpens, FROZEN_DATA } from './button-state.ts'
import { runReply, copyTextProblem, COPY_TEXT_MAX } from './outbound.ts'
import { serveAlertTap, type AlertTapDeps } from './alert-tap.ts'
import { TAIL_FLEET_POSTS_BIN } from './peer-posts.ts'

setDefaultTimeout(30_000)

const GROUP = '-1004286764447'
const MONTY = '111'
const QUESTION = 'Ship the tunnel change tonight, or hold it for Monday?'

// --- pins: unit ----------------------------------------------------------------

type ApiCall = { method: string; args: unknown[] }
function pinHarness(over: Partial<PinApi> = {}, member: { status: string; can_pin_messages?: boolean } = { status: 'administrator', can_pin_messages: true }) {
  const calls: ApiCall[] = []
  const errs: string[] = []
  const ran: string[][] = []
  const dir = mkdtempSync(join(tmpdir(), 'pin-test-'))
  const file = join(dir, 'pins.json')
  const api: PinApi = {
    pinChatMessage: async (...args) => { calls.push({ method: 'pinChatMessage', args }); return true },
    unpinChatMessage: async (...args) => { calls.push({ method: 'unpinChatMessage', args }); return true },
    getMe: async () => ({ id: 42 }),
    getChatMember: async (...args) => { calls.push({ method: 'getChatMember', args }); return member },
    ...over,
  }
  const sent = new SentPosts()
  sent.note(GROUP, 900, { text: QUESTION, thread_id: 40 })
  let now = new Date('2026-11-21T12:00:00Z')
  const deps: PinDeps & SweepDeps = {
    api, sent, store: filePinStore(file),
    assertAllowedChat: () => {},
    stderr: s => { errs.push(s) },
    now: () => now,
    run: async argv => { ran.push(argv); return { rc: 0, stdout: '', stderr: '' } },
    agent: 'Grady',
  }
  return { deps, calls, errs, ran, file, sent, methods: () => calls.map(c => c.method), at: (d: string) => { now = new Date(d) } }
}
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text

test('pin: pins its own one-line question with a notification and records it in the state dir', async () => {
  const h = pinHarness()
  const r = await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  expect(r.isError).toBeUndefined()
  expect(h.calls).toEqual([{ method: 'pinChatMessage', args: [GROUP, 900, { disable_notification: false }] }])
  expect(JSON.parse(readFileSync(h.file, 'utf8'))).toEqual({
    pins: [{ chat_id: GROUP, thread_id: 40, message_id: 900, pinned_at: '2026-11-21T12:00:00.000Z', question: QUESTION }],
  })
  expect(text(r)).toContain('pinned (id: 900)')
})

test('pin: a message that is not a one-line question is refused and never pinned', async () => {
  const h = pinHarness()
  h.sent.note(GROUP, 901, { text: 'The tunnel change is deployed on all three hosts.', thread_id: 40 })
  h.sent.note(GROUP, 902, { text: 'Two things.\nShip it?', thread_id: 40 })
  h.sent.note(GROUP, 903, { text: `${'x'.repeat(PIN_QUESTION_MAX)}?`, thread_id: 40 })
  for (const id of ['901', '902', '903']) {
    const r = await runPinMessage(h.deps, { chat_id: GROUP, message_id: id })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('pin_message refused: a pin is one question to Monty on one line')
  }
  expect(h.methods()).toEqual([])
  expect(existsSync(h.file)).toBe(false)
  expect(notAQuestion(QUESTION)).toBeUndefined()
})

test('pin: a message this bot did not send in this session is refused', async () => {
  const h = pinHarness()
  const r = await runPinMessage(h.deps, { chat_id: GROUP, message_id: '555' })
  expect(r.isError).toBe(true)
  expect(text(r)).toContain('is not one this bot sent in this session')
  expect(h.methods()).toEqual([])
})

test('pin: a second pin in the same topic is refused, and one in another topic is not', async () => {
  const h = pinHarness()
  h.sent.note(GROUP, 910, { text: 'Rename the topic too?', thread_id: 40 })
  h.sent.note(GROUP, 911, { text: 'Rename the topic too?', thread_id: 77 })
  await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  const second = await runPinMessage(h.deps, { chat_id: GROUP, message_id: '910' })
  expect(second.isError).toBe(true)
  expect(text(second)).toContain('already has a pin in this topic (message 900')
  const other = await runPinMessage(h.deps, { chat_id: GROUP, message_id: '911' })
  expect(other.isError).toBeUndefined()
  expect(h.calls.filter(c => c.method === 'pinChatMessage').map(c => c.args[1])).toEqual([900, 911])
})

test('pin: without can_pin_messages the tool returns an error naming that right, and records nothing', async () => {
  const refuse = async () => { throw Object.assign(new Error('400'), { description: 'Bad Request: not enough rights to manage pinned messages in the chat' }) }
  for (const member of [{ status: 'member' }, { status: 'administrator', can_pin_messages: false }]) {
    const h = pinHarness({ pinChatMessage: refuse }, member)
    const r = await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('pin_message failed: this bot lacks the admin right can_pin_messages in this chat')
    expect(text(r)).toContain('not enough rights to manage pinned messages')
    expect(h.calls).toEqual([{ method: 'getChatMember', args: [GROUP, 42] }])
    expect(existsSync(h.file)).toBe(false)
  }
  // Telegram will not say what the bot is: the right is still named.
  const blind = pinHarness({ pinChatMessage: refuse, getChatMember: async () => { throw new Error('nope') } })
  const r = await runPinMessage(blind.deps, { chat_id: GROUP, message_id: '900' })
  expect(r.isError).toBe(true)
  expect(text(r)).toContain('needs the admin right can_pin_messages')
})

test('pin: his reply, his tap and his thumbs-up each unpin the message and clear the record', async () => {
  for (const how of ['reply', 'tap', 'thumbs-up'] as const) {
    const h = pinHarness()
    await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
    expect(await releaseOnAnswer(h.deps, { chat_id: GROUP, message_id: 900, how })).toBe(true)
    expect(h.calls.at(-1)).toEqual({ method: 'unpinChatMessage', args: [GROUP, 900] })
    expect(h.deps.store.load()).toEqual([])
  }
})

test('pin: an answer to a message that is not a pin unpins nothing', async () => {
  const h = pinHarness()
  await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  expect(await releaseOnAnswer(h.deps, { chat_id: GROUP, message_id: 901, how: 'reply' })).toBe(false)
  expect(h.methods()).toEqual(['pinChatMessage'])
  expect(h.deps.store.load().length).toBe(1)
})

test('pin: an unpin that fails on his answer is kept as answered, and the sweep retries it', async () => {
  let fail = true
  const h = pinHarness({ unpinChatMessage: async () => { if (fail) throw new Error('ETIMEDOUT'); return true } })
  await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  expect(await releaseOnAnswer(h.deps, { chat_id: GROUP, message_id: 900, how: 'reply' })).toBe(true)
  expect(h.deps.store.load()).toEqual([expect.objectContaining({ message_id: 900, answered_at: '2026-11-21T12:00:00.000Z' })])
  expect(h.errs.join('')).toContain('the unpin failed, will retry')
  // An answered pin no longer holds the topic, and is never filed with Page.
  h.at('2026-11-23T12:00:00Z')
  await sweepPins(h.deps)
  expect(h.ran).toEqual([])
  expect(h.deps.store.load().length).toBe(1)
  fail = false
  await sweepPins(h.deps)
  expect(h.deps.store.load()).toEqual([])
})

test('pin: a pin standing 24 hours is filed with Page once as a blocker, and stays pinned', async () => {
  const h = pinHarness()
  await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  h.at(new Date(Date.parse('2026-11-21T12:00:00Z') + PIN_AGE_MS - 1000).toISOString())
  await sweepPins(h.deps)
  expect(h.ran).toEqual([])
  h.at(new Date(Date.parse('2026-11-21T12:00:00Z') + PIN_AGE_MS).toISOString())
  await sweepPins(h.deps)
  await sweepPins(h.deps)
  expect(h.ran).toEqual([[
    INTERRUPT_BIN, 'add', '--tier', 'blocker', '--from', 'Grady',
    '--text', `Pinned for Monty in topic 40 and unanswered for 24 hours: ${QUESTION}`,
  ]])
  expect(h.methods()).toEqual(['pinChatMessage'])
  expect(h.deps.store.load()).toEqual([expect.objectContaining({ message_id: 900, escalated_at: expect.any(String) })])
})

test('pin: a filing that fails is tried again at the next sweep', async () => {
  const h = pinHarness()
  let rc = 1
  h.deps.run = async argv => { h.ran.push(argv); return { rc, stdout: '', stderr: 'CANONICAL STORE UNREACHABLE' } }
  await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  h.at('2026-11-22T13:00:00Z')
  await sweepPins(h.deps)
  expect(h.deps.store.load()[0].escalated_at).toBeUndefined()
  rc = 0
  await sweepPins(h.deps)
  expect(h.ran.length).toBe(2)
  expect(h.deps.store.load()[0].escalated_at).toBe('2026-11-22T13:00:00.000Z')
})

test('unpin: takes down only a pin on this bot\'s record, and list_pins reads the record after a restart', async () => {
  const h = pinHarness()
  await runPinMessage(h.deps, { chat_id: GROUP, message_id: '900' })
  const stranger = await runUnpinMessage(h.deps, { chat_id: GROUP, message_id: '4242' })
  expect(stranger.isError).toBe(true)
  expect(text(stranger)).toContain('has no pin on record for message 4242')
  expect(h.methods()).toEqual(['pinChatMessage'])
  // A new process: nothing in memory, the same file.
  const restarted = { ...h.deps, sent: new SentPosts(), store: filePinStore(h.file) }
  const listed = JSON.parse(text(runListPins(restarted))) as Pin[]
  expect(listed).toEqual([{ chat_id: GROUP, thread_id: 40, message_id: 900, pinned_at: '2026-11-21T12:00:00.000Z', question: QUESTION }])
  const r = await runUnpinMessage(restarted, { chat_id: GROUP, message_id: '900' })
  expect(text(r)).toBe('unpinned (id: 900)')
  expect(h.calls.at(-1)).toEqual({ method: 'unpinChatMessage', args: [GROUP, 900] })
  expect(text(runListPins(restarted))).toBe('no pins')
})

// --- copy buttons ----------------------------------------------------------------

function replyHarness() {
  const sends: Array<{ chat_id: string; text: string; other: Record<string, unknown> | undefined }> = []
  const noted: unknown[] = []
  const deps = {
    api: {
      sendMessage: async (chat_id: string, t: string, other?: Record<string, unknown>) => { sends.push({ chat_id, text: t, other }); return { message_id: 700 + sends.length } },
      sendPhoto: async () => ({ message_id: 1 }),
      sendDocument: async () => ({ message_id: 1 }),
    },
    loadAccess: () => ({}),
    assertAllowedChat: () => {},
    assertSendable: () => {},
    stopTyping: () => {},
    sent: (p: unknown) => { noted.push(p) },
  }
  return { deps, sends, noted }
}

test('copy button: copy_text reaches the API unchanged, beside a callback button', async () => {
  const h = replyHarness()
  const cmd = 'for h in maxi mini mbp; do ssh $h uptime; done'
  const markup = { inline_keyboard: [[{ text: 'Copy', copy_text: { text: cmd }, style: 'primary' }, { text: 'Done', callback_data: 'x:done', style: 'success' }]] }
  await runReply(h.deps, { chat_id: MONTY, text: 'Run this on maxi:', reply_markup: markup })
  expect(h.sends.length).toBe(1)
  expect(h.sends[0].other?.reply_markup).toEqual(markup)
})

test('copy button: text over 256 characters or over one line is refused before anything is sent', async () => {
  for (const bad of ['x'.repeat(COPY_TEXT_MAX + 1), 'echo one\necho two', '']) {
    const h = replyHarness()
    const call = runReply(h.deps, { chat_id: MONTY, text: 'Run this:', reply_markup: { inline_keyboard: [[{ text: 'Copy', copy_text: { text: bad }, style: 'primary' }]] } })
    await expect(call).rejects.toThrow('copy button "Copy" refused')
    expect(h.sends).toEqual([])
  }
  expect(copyTextProblem({ text: 'x'.repeat(COPY_TEXT_MAX) })).toBeUndefined()
})

test('copy button: the reply tool\'s schema declares copy_text and does not require callback_data', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const start = src.indexOf("name: 'reply',")
  const schema = src.slice(start, src.indexOf("name: 'react',", start))
  expect(schema).toContain('copy_text: {')
  expect(schema).toContain("required: ['text'],")
  expect(schema).not.toContain("required: ['text', 'callback_data']")
})

test('reply: each text message sent is noted with its chat, thread and text, for pin_message', async () => {
  const h = replyHarness()
  await runReply(h.deps, { chat_id: GROUP, text: QUESTION, message_thread_id: 40 })
  expect(h.noted).toEqual([{ chat_id: GROUP, thread_id: 40, message_id: 701, text: QUESTION }])
})

// --- button state: unit ------------------------------------------------------------

const KB = () => ({
  inline_keyboard: [
    [{ text: 'Yes', callback_data: 'grady:yes', style: 'success' }, { text: 'No', callback_data: 'grady:no', style: 'danger' }],
    [{ text: 'Copy', copy_text: { text: 'ls' } }],
  ],
})

test('button state: a choice becomes the one button, checked, and the others are removed', () => {
  expect(chosenKeyboard(KB(), 'grady:yes', false)).toEqual({ inline_keyboard: [[{ text: '✓ Yes', callback_data: FROZEN_DATA, style: 'success' }]] })
  expect(chosenKeyboard(KB(), 'grady:maybe', false)).toBeUndefined()
  expect(chosenKeyboard(undefined, 'grady:yes', false)).toBeUndefined()
})

test('button state: a tap that opens or shows something is checked and every button stays', async () => {
  const docs = { inline_keyboard: [[{ text: 'The spec', callback_data: 'omf:abc123' }], [{ text: 'The drill', callback_data: 'omf:def456' }]] }
  const edits: unknown[] = []
  const deps = { edit: async (m: unknown) => { edits.push(m) }, stderr: () => {} }
  expect(await markTapped(deps, docs, 'omf:abc123')).toBe('marked')
  expect(edits).toEqual([{ inline_keyboard: [[{ text: '✓ The spec', callback_data: 'omf:abc123' }], [{ text: 'The drill', callback_data: 'omf:def456' }]] }])
  // Tapped again: already marked, nothing to edit.
  expect(await markTapped(deps, edits[0] as never, 'omf:abc123')).toBe('unchanged')
  expect(['omf:abc123', 'open:WIP:x.md', 'al:fx:maxi:abcdef'].map(showsOrOpens)).toEqual([true, true, true])
  expect(['grady:yes', 'al:ig:maxi:abcdef', 'al:tk:maxi:abcdef', 'aw:dn:abcdef', 'perm:allow:abcde'].map(showsOrOpens)).toEqual([false, false, false, false, false])
})

test('button state: a choice is frozen through markTapped, and a failed edit never rejects', async () => {
  const edits: unknown[] = []
  expect(await markTapped({ edit: async m => { edits.push(m) }, stderr: () => {} }, KB(), 'grady:no')).toBe('frozen')
  expect(edits).toEqual([{ inline_keyboard: [[{ text: '✓ No', callback_data: FROZEN_DATA, style: 'danger' }]] }])
  const errs: string[] = []
  expect(await markTapped({ edit: async () => { throw new Error('message is not modified') }, stderr: s => { errs.push(s) } }, KB(), 'grady:no')).toBe('failed')
  expect(errs.join('')).toContain('button state: keyboard edit failed')
})

test('button state: a second tap on a frozen button toasts what was chosen', () => {
  expect(frozenToast({ inline_keyboard: [[{ text: '✓ Yes', callback_data: FROZEN_DATA }]] })).toBe('Already chosen: Yes')
  expect(frozenToast(undefined)).toBe('Already chosen.')
})

test('alert tap: the served tap says whether the command took it', async () => {
  const deps = (stdout: string): AlertTapDeps => ({
    run: async () => ({ rc: 0, stdout, stderr: '' }),
    send: async () => ({ message_id: 1 }),
    topics: () => undefined, log: () => {}, stderr: () => {},
  })
  const tap = { kind: 'al' as const, verb: 'ig', host: 'maxi', id: 'abcdef' }
  expect((await serveAlertTap(deps('{"ok":true,"toast":"Ignored"}'), tap, { user_id: MONTY })).ok).toBe(true)
  expect((await serveAlertTap(deps('{"ok":false,"toast":"No such alert"}'), tap, { user_id: MONTY })).ok).toBe(false)
  expect((await serveAlertTap(deps(''), tap, { user_id: MONTY })).ok).toBe(false)
})

// --- end to end: the real server.ts against a stub Bot API ----------------------------

const TOKEN = '123456:TEST-ONLY-fixture-token-never-live'
const BOT = 'MK_TestyBot'
const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups) c() })

type StubCall = { method: string; body: Record<string, any> }
function startStub() {
  const calls: StubCall[] = []
  const queue: object[] = []
  let updateId = 1000
  let nextMessageId = 5000
  // method -> a response to give instead of the default
  const answers: Record<string, () => { status: number; body: unknown }> = {}
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
      if (answers[m[2]]) { const a = answers[m[2]](); return reply(a.status, a.body) }
      switch (m[2]) {
        case 'getMe':
          return reply(200, { ok: true, result: { id: 42, is_bot: true, first_name: 'Testy', username: BOT, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } })
        case 'getUpdates': {
          if (queue.length === 0) await Bun.sleep(150)
          return reply(200, { ok: true, result: queue.splice(0).map(u => ({ update_id: updateId++, ...u })) })
        }
        case 'sendMessage':
          return reply(200, { ok: true, result: { message_id: nextMessageId++, date: 1, chat: { id: Number(body.chat_id), type: 'supergroup' }, text: body.text } })
        case 'getChatMember':
          return reply(200, { ok: true, result: { status: 'member', user: { id: 42, is_bot: true, first_name: 'Testy' } } })
      }
      return reply(200, { ok: true, result: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls, answers,
    of: (method: string) => calls.filter(c => c.method === method),
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

async function startBridge(stub: ReturnType<typeof startStub>) {
  const home = mkdtempSync(join(tmpdir(), 'pin-e2e-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'state', 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [MONTY], pending: {},
    groups: { [GROUP]: { requireMention: true, allowFrom: [], threads: { '40': { requireMention: false } } } },
  }))
  // Stub commands: interrupt records its arguments; fleet-andon answers a tap.
  const stubBin = (name: string, script: string) => { const p = join(home, name); writeFileSync(p, script); chmodSync(p, 0o755); return p }
  const interrupt = stubBin('interrupt', `#!/bin/sh\necho "$*" >> "${home}/interrupt.calls"\n`)
  const andon = stubBin('fleet-andon', `#!/bin/sh\necho '{"ok":true,"toast":"Taken","key":"drill:key@maxi","button":"'"$2"'"}'\n`)
  const p = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TELEGRAM_STATE_DIR: join(home, 'state'),
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_ROOT: stub.url,
      TELEGRAM_TEE_DIR: join(home, 'tee'),
      TAIL_FLEET_POSTS_BIN,
      TAIL_FLEET_POSTS_HOST: 'maxi',
      TAIL_FLEET_POSTS_DIR: join(home, 'tee'),
      TAIL_FLEET_POSTS_READ_MINI: `${TAIL_FLEET_POSTS_BIN} --dump ${join(home, 'tee')}`,
      PIN_INTERRUPT_BIN: interrupt,
      ALERT_TAP_ANDON: andon,
      ALERT_TAP_LOG: join(home, 'alert-taps.jsonl'),
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
  const call = async (name: string, args: object) => {
    const mine = ++id
    send({ jsonrpc: '2.0', id: mine, method: 'tools/call', params: { name, arguments: args } })
    const res = await until(() => lines().find(m => m.id === mine))
    return res.result as { content: Array<{ text: string }>; isError?: boolean }
  }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pin-test', version: '0' } } })
  await until(() => lines().find(m => m.id === 1))
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await until(() => err.includes(`polling as @${BOT}`))
  return {
    home, call,
    stderr: () => err,
    events: () => lines().filter(m => m.method === 'notifications/claude/channel').map(m => m.params),
    pins: () => { try { return JSON.parse(readFileSync(join(home, 'state', 'pins.json'), 'utf8')).pins as Pin[] } catch { return [] } },
    kill: () => p.kill('SIGKILL'),
  }
}

const from = { id: Number(MONTY), is_bot: false, first_name: 'Monty', username: 'monty' }
const tap = (message_id: number, data: string, keyboard: object[][], chat: object = { id: Number(MONTY), type: 'private' }) => ({
  callback_query: {
    id: `cq-${message_id}-${data}`, from, chat_instance: 'ci', data,
    message: { message_id, date: 1, chat, text: 'Pick one', reply_markup: { inline_keyboard: keyboard } },
  },
})

test('end to end, pin: ask, pin, and his reply unpins it; his thumbs-up and his tap do the same', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub)
  const ask = async () => {
    const sent = await bridge.call('reply', { chat_id: GROUP, text: QUESTION, message_thread_id: 40, reply_markup: { inline_keyboard: [[{ text: 'Tonight', callback_data: 'x:tonight', style: 'success' }, { text: 'Monday', callback_data: 'x:monday', style: 'primary' }]] } })
    const id = Number(/id: (\d+)/.exec(sent.content[0].text)![1])
    const pinned = await bridge.call('pin_message', { chat_id: GROUP, message_id: String(id) })
    expect(pinned.isError).toBeUndefined()
    expect(stub.of('pinChatMessage').at(-1)!.body).toEqual({ chat_id: GROUP, message_id: id, disable_notification: false })
    expect(bridge.pins()).toEqual([expect.objectContaining({ chat_id: GROUP, thread_id: 40, message_id: id, question: QUESTION })])
    return id
  }
  const released = async (id: number, n: number) => {
    await until(() => stub.of('unpinChatMessage').length === n)
    expect(stub.of('unpinChatMessage').at(-1)!.body).toEqual({ chat_id: GROUP, message_id: id })
    await until(() => bridge.pins().length === 0)
  }
  const chat = { id: Number(GROUP), type: 'supergroup', title: 'Fleet', is_forum: true }

  // A post of his in the topic that replies to something else releases nothing.
  const first = await ask()
  stub.push({ message: { message_id: 6000, date: 1, chat, from, message_thread_id: 40, is_topic_message: true, text: 'unrelated', reply_to_message: { message_id: 40, date: 1, chat } } })
  await until(() => bridge.events().some(e => e.meta.message_id === '6000'))
  expect(stub.of('unpinChatMessage')).toEqual([])
  expect(bridge.pins().length).toBe(1)
  // His reply to the pinned question.
  stub.push({ message: { message_id: 6001, date: 1, chat, from, message_thread_id: 40, is_topic_message: true, text: 'Tonight.', reply_to_message: { message_id: first, date: 1, chat, from: { id: 42, is_bot: true, first_name: 'Testy', username: BOT } } } })
  await released(first, 1)

  // His thumbs-up.
  const second = await ask()
  stub.push({ message_reaction: { chat, message_id: second, user: from, date: 1, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } })
  await released(second, 2)

  // His tap on one of its buttons, which also freezes the choice.
  const third = await ask()
  stub.push(tap(third, 'x:monday', [[{ text: 'Tonight', callback_data: 'x:tonight', style: 'success' }, { text: 'Monday', callback_data: 'x:monday', style: 'primary' }]], chat))
  await released(third, 3)
  await until(() => stub.of('editMessageReplyMarkup').length === 1)
  expect(stub.of('editMessageReplyMarkup')[0].body).toEqual({ chat_id: Number(GROUP), message_id: third, reply_markup: { inline_keyboard: [[{ text: '✓ Monday', callback_data: FROZEN_DATA, style: 'primary' }]] } })
  expect(existsSync(join(bridge.home, 'interrupt.calls'))).toBe(false)
  bridge.kill()
})

test('end to end, pin: a bot without can_pin_messages gets an error naming the right, and no pin is recorded', async () => {
  const stub = startStub()
  stub.answers.pinChatMessage = () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: not enough rights to manage pinned messages in the chat' } })
  const bridge = await startBridge(stub)
  const sent = await bridge.call('reply', { chat_id: GROUP, text: QUESTION, message_thread_id: 40 })
  const id = /id: (\d+)/.exec(sent.content[0].text)![1]
  const r = await bridge.call('pin_message', { chat_id: GROUP, message_id: id })
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toContain('this bot lacks the admin right can_pin_messages in this chat (it is "member", not an administrator)')
  expect(stub.of('getChatMember')[0].body).toEqual({ chat_id: GROUP, user_id: 42 })
  expect(bridge.pins()).toEqual([])
  // And a statement is not pinned at all: nothing is asked of Telegram.
  const said = await bridge.call('reply', { chat_id: GROUP, text: 'Deployed on all three hosts.', message_thread_id: 40 })
  const not = await bridge.call('pin_message', { chat_id: GROUP, message_id: /id: (\d+)/.exec(said.content[0].text)![1] })
  expect(not.isError).toBe(true)
  expect(stub.of('pinChatMessage').length).toBe(1)
  bridge.kill()
})

test('end to end, button state: a generic tap freezes the choice, and a second tap reaches nobody', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub)
  const kb = [[{ text: 'Yes', callback_data: 'grady:yes', style: 'success' }, { text: 'No', callback_data: 'grady:no', style: 'danger' }]]
  stub.push(tap(50, 'grady:yes', kb))
  await until(() => stub.of('editMessageReplyMarkup').length === 1)
  expect(stub.of('editMessageReplyMarkup')[0].body).toEqual({ chat_id: Number(MONTY), message_id: 50, reply_markup: { inline_keyboard: [[{ text: '✓ Yes', callback_data: FROZEN_DATA, style: 'success' }]] } })
  expect(bridge.events().map(e => e.meta.callback_data)).toEqual(['grady:yes'])

  stub.push(tap(50, FROZEN_DATA, [[{ text: '✓ Yes', callback_data: FROZEN_DATA, style: 'success' }]]))
  await until(() => stub.of('answerCallbackQuery').some(c => c.body.text === 'Already chosen: Yes'))
  expect(bridge.events().map(e => e.meta.callback_data)).toEqual(['grady:yes'])
  expect(stub.of('editMessageReplyMarkup').length).toBe(1)
  bridge.kill()
})

test('end to end, button state: an alert\'s Ignore freezes, and its Show fix is checked with every button kept', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub)
  const kb = [
    [{ text: 'Ignore', callback_data: 'al:ig:maxi:abcdef', style: 'danger' }, { text: 'Snooze 1h', callback_data: 'al:s1:maxi:abcdef', style: 'primary' }],
    [{ text: 'Show fix', callback_data: 'al:fx:maxi:abcdef', style: 'primary' }],
  ]
  stub.push(tap(60, 'al:fx:maxi:abcdef', kb))
  await until(() => stub.of('editMessageReplyMarkup').length === 1)
  expect(stub.of('editMessageReplyMarkup')[0].body.reply_markup).toEqual({ inline_keyboard: [kb[0], [{ text: '✓ Show fix', callback_data: 'al:fx:maxi:abcdef', style: 'primary' }]] })
  stub.push(tap(60, 'al:ig:maxi:abcdef', kb))
  await until(() => stub.of('editMessageReplyMarkup').length === 2)
  expect(stub.of('editMessageReplyMarkup')[1].body.reply_markup).toEqual({ inline_keyboard: [[{ text: '✓ Ignore', callback_data: FROZEN_DATA, style: 'danger' }]] })
  expect(bridge.events()).toEqual([])
  bridge.kill()
})

test('button state: the omf: and open: handlers mark the tap, and a generic tap that was not delivered stays tappable', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const omf = src.slice(src.indexOf('const omfMatch = '), src.indexOf('const openMatch = '))
  expect(omf).toContain('void markTap()')
  const open = src.slice(src.indexOf('const openMatch = '), src.indexOf('// Feature 3: General inline keyboard callback'))
  expect(open).toContain('void markTap()')
  expect(src).toContain("if (outcome !== 'rejected') await markTap()")
  expect(src).toContain('if (served.ok) void markTap()')
})

// --- pin-right-check.ts ---------------------------------------------------------------

test('pin-right-check: prints each group\'s status and whether the right is held, and never the token', async () => {
  const stub = startStub()
  const root = mkdtempSync(join(tmpdir(), 'pin-right-'))
  mkdirSync(join(root, 'telegram-testy'))
  writeFileSync(join(root, 'telegram-testy', '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
  writeFileSync(join(root, 'telegram-testy', 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [MONTY], groups: { [GROUP]: { requireMention: true, allowFrom: [] } } }))
  const run = async () => {
    const p = Bun.spawn(['bun', join(import.meta.dir, 'pin-right-check.ts'), 'Testy'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, FLEET_CHANNEL_ROOT: root, PIN_RIGHT_CHECK_API_ROOT: stub.url },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    expect(out + err).not.toContain(TOKEN)
    return { out, code }
  }
  const member = await run()
  expect(member.code).toBe(0)
  expect(JSON.parse(member.out)).toEqual({ agent: 'Testy', bot: BOT, chat_id: GROUP, status: 'member', holds: false })
  stub.answers.getChatMember = () => ({ status: 200, body: { ok: true, result: { status: 'administrator', can_pin_messages: true, user: { id: 42, is_bot: true, first_name: 'Testy' } } } })
  expect(JSON.parse((await run()).out)).toEqual({ agent: 'Testy', bot: BOT, chat_id: GROUP, status: 'administrator', holds: true })
  // Telegram will not say: holds is null and the exit is 1, never a guess.
  stub.answers.getChatMember = () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } })
  const blind = await run()
  expect(blind.code).toBe(1)
  expect(JSON.parse(blind.out)).toEqual({ agent: 'Testy', bot: BOT, chat_id: GROUP, status: null, holds: null })
  expect(stub.calls.every(c => c.method === 'getMe' || c.method === 'getChatMember')).toBe(true)
})
