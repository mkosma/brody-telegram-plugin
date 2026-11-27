// The bridge refuses a post into a private chat (private-chat.ts).
// Design: agents/Grady/design/DESIGN-bridge-refuses-bot-dms-2026-11-27, drill
// item 4: a reply, edit and react to his DM are refused with the error that
// names the home; the same in the FLEET group pass; each listed exemption
// still sends. Each test below has a revert in revert-proofs.py (ids DM*).
//
// Nothing here reaches Telegram or Monty. The unit tests hand the code a stub
// API; the end-to-end tests run the real server.ts as a subprocess under a
// temp HOME, with a local stub standing in for the Bot API.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Api } from 'grammy'
import {
  PRIVATE_CHAT_REFUSAL, PRIVATE_CHAT_EXEMPTIONS, assertOutboundChat, exempt, isPrivateChatId, refusePrivateChat,
  type PrivateChatExemption,
} from './private-chat.ts'
import { runReply, runEditMessage, runReact } from './reply.ts'
import { SentPosts, filePinStore, runPinMessage, runUnpinMessage, type PinApi, type PinDeps } from './pin.ts'
import { runCreateForumTopic, runEditForumTopic } from './forum-topic.ts'
import { TAIL_FLEET_POSTS_BIN } from './peer-posts.ts'

setDefaultTimeout(30_000)

const GROUP = '-1004286764447'
const MONTY = '111'
const STRANGER = '999'
const QUESTION = 'Ship the tunnel change tonight, or hold it for Monday?'
const HOME_LINE = "Monty's DM is not a work channel: post in the FLEET topic where the work is."

// --- the gate and the tools: unit ---------------------------------------------------

const ACCESS = { allowFrom: [MONTY], groups: { [GROUP]: { requireMention: true } } }
/** The gate as server.ts builds it: the real assertOutboundChat over an access with his id in allowFrom. */
const gate = (chat_id: string) => assertOutboundChat(ACCESS, chat_id, 'edit-telegram-access Testy')

function toolHarness() {
  const calls: Array<{ method: string; chat_id: unknown }> = []
  const rec = (method: string, result: unknown = true) => async (chat_id: unknown) => { calls.push({ method, chat_id }); return result as never }
  const api = {
    sendMessage: rec('sendMessage', { message_id: 900 }),
    sendPhoto: rec('sendPhoto', { message_id: 901 }),
    sendDocument: rec('sendDocument', { message_id: 902 }),
    editMessageText: rec('editMessageText', { message_id: 900 }),
    setMessageReaction: rec('setMessageReaction'),
    pinChatMessage: rec('pinChatMessage'),
    unpinChatMessage: rec('unpinChatMessage'),
    createForumTopic: rec('createForumTopic', { message_thread_id: 77, name: 'x' }),
    editForumTopic: rec('editForumTopic'),
    getMe: async () => ({ id: 42 }),
    getChatMember: async () => ({ status: 'administrator', can_pin_messages: true }),
  }
  const dir = mkdtempSync(join(tmpdir(), 'private-chat-'))
  const sent = new SentPosts()
  const pinDeps: PinDeps = {
    api: api as unknown as PinApi, sent, store: filePinStore(join(dir, 'pins.json')),
    assertAllowedChat: gate,
    assertUnpinChat: c => assertOutboundChat(ACCESS, c, 'edit-telegram-access Testy', 'pin-release'),
    stderr: () => {},
  }
  const stopped: string[] = []
  const tools = (chat_id: string): Record<string, () => Promise<unknown>> => ({
    reply: () => runReply({ api, loadAccess: () => ({}), assertAllowedChat: gate, assertSendable: () => {}, stopTyping: c => { stopped.push(c) } }, { chat_id, text: 'hello' }),
    edit_message: () => runEditMessage({ api, assertAllowedChat: gate }, { chat_id, message_id: '900', text: 'edited' }),
    react: () => runReact({ api, assertAllowedChat: gate }, { chat_id, message_id: '900', emoji: '👀' }),
    pin_message: () => runPinMessage(pinDeps, { chat_id, message_id: '900' }),
    create_forum_topic: () => runCreateForumTopic({ api, assertAllowedChat: gate, isStatic: true, loadAccess: () => ({ groups: {} }) as never, saveAccess: () => {} }, { chat_id, name: 'x' }),
    edit_forum_topic: () => runEditForumTopic({ api, assertAllowedChat: gate }, { chat_id, message_thread_id: 39, name: 'x' }),
  })
  return { api, calls, sent, pinDeps, stopped, tools, dir }
}

test('private chat: reply, edit_message, react, pin_message and the topic tools to his DM are refused with the line that names the home, and nothing is sent', async () => {
  // The design's words, exactly: an agent reads this and knows where to post.
  expect(PRIVATE_CHAT_REFUSAL).toBe(HOME_LINE)
  const h = toolHarness()
  h.sent.note(MONTY, 900, { text: QUESTION, thread_id: undefined })
  for (const [name, run] of Object.entries(h.tools(MONTY))) {
    let said = ''
    try { await run() } catch (e) { said = (e as Error).message }
    expect(`${name}: ${said}`).toBe(`${name}: ${HOME_LINE}`)
  }
  expect(h.calls).toEqual([])
  // Refused before the reply's side effects too: the typing keepalive is not touched.
  expect(h.stopped).toEqual([])
  // A private chat is refused whether or not its user is allowlisted, and with the same line.
  expect(() => gate(STRANGER)).toThrow(HOME_LINE)
  expect(() => gate('111')).toThrow(HOME_LINE)
})

test('private chat: the same tools in the FLEET group pass', async () => {
  const h = toolHarness()
  h.sent.note(GROUP, 900, { text: QUESTION, thread_id: 40 })
  for (const run of Object.values(h.tools(GROUP))) await run()
  expect(h.calls).toEqual([
    { method: 'sendMessage', chat_id: GROUP },
    { method: 'editMessageText', chat_id: GROUP },
    { method: 'setMessageReaction', chat_id: GROUP },
    { method: 'pinChatMessage', chat_id: GROUP },
    { method: 'createForumTopic', chat_id: GROUP },
    { method: 'editForumTopic', chat_id: GROUP },
  ])
  // A group that is not allowlisted is still refused, by the allowlist, not as a DM.
  expect(() => gate('-100999')).toThrow('chat -100999 is not allowlisted')
})

test('private chat: unpin_message alone may name a DM (pin-release), and only an allowlisted one', async () => {
  const h = toolHarness()
  h.pinDeps.store.save([{ chat_id: MONTY, thread_id: null, message_id: 77, pinned_at: '2026-11-20T12:00:00.000Z', question: QUESTION }])
  const r = await runUnpinMessage(h.pinDeps, { chat_id: MONTY, message_id: '77' })
  expect(r.isError).toBeUndefined()
  expect(h.calls).toEqual([{ method: 'unpinChatMessage', chat_id: MONTY }])
  expect(h.pinDeps.store.load()).toEqual([])
  // The exemption lifts the private-chat refusal and nothing else.
  await expect(runUnpinMessage(h.pinDeps, { chat_id: STRANGER, message_id: '77' })).rejects.toThrow(`chat ${STRANGER} is not allowlisted`)
  // And pin_message has no such way in: the exemption is fixed at the wiring, not passed.
  await expect(runPinMessage(h.pinDeps, { chat_id: MONTY, message_id: '77', exemption: 'pin-release' })).rejects.toThrow(HOME_LINE)
})

// --- the transformer: unit ----------------------------------------------------------

const POSTING = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendChatAction', 'editMessageText', 'editMessageReplyMarkup', 'setMessageReaction', 'pinChatMessage', 'unpinChatMessage', 'forwardMessage', 'copyMessage', 'createForumTopic', 'deleteMessage']

function passes(method: string, payload: Record<PropertyKey, unknown>): Promise<'sent' | string> {
  let reached = false
  return refusePrivateChat(async () => { reached = true; return { ok: true as const, result: true } }, method, payload).then(
    () => (reached ? 'sent' : 'swallowed'),
    e => (reached ? 'sent-then-threw' : (e as Error).message),
  )
}

test('private chat: every call that posts into a private chat is refused by the API layer, and one into a group or a read passes', async () => {
  for (const method of POSTING) {
    for (const chat_id of [MONTY, Number(MONTY), STRANGER]) {
      expect(await passes(method, { chat_id, text: 'x' })).toBe(`${HOME_LINE} (${method} to a private chat refused by the bridge)`)
    }
    expect(await passes(method, { chat_id: GROUP, text: 'x' })).toBe('sent')
    expect(await passes(method, { chat_id: Number(GROUP), text: 'x' })).toBe('sent')
  }
  // Reads post nothing, and calls with no chat are not about a chat.
  expect(await passes('getChatMember', { chat_id: MONTY, user_id: 42 })).toBe('sent')
  expect(await passes('getChat', { chat_id: MONTY })).toBe('sent')
  expect(await passes('getUpdates', { timeout: 30 })).toBe('sent')
  expect(await passes('answerCallbackQuery', { callback_query_id: 'cq', text: 'toast' })).toBe('sent')
  expect(await passes('setMyCommands', { commands: [], scope: { type: 'all_private_chats' } })).toBe('sent')
  expect(isPrivateChatId(MONTY) && isPrivateChatId(111) && !isPrivateChatId(GROUP) && !isPrivateChatId('@fleet') && !isPrivateChatId(undefined)).toBe(true)
})

test('private chat: a named exemption sends for the methods it covers and no other, and no argument an agent can pass is one', async () => {
  for (const [name, row] of Object.entries(PRIVATE_CHAT_EXEMPTIONS)) {
    for (const method of POSTING) {
      const got = await passes(method, { chat_id: MONTY, ...exempt(name as PrivateChatExemption) })
      const covered = (row.methods as readonly string[]).includes(method)
      expect(`${name} ${method}: ${got.startsWith(HOME_LINE) ? 'refused' : got}`).toBe(`${name} ${method}: ${covered ? 'sent' : 'refused'}`)
    }
  }
  // An unknown name is no exemption.
  expect(await passes('sendMessage', { chat_id: MONTY, ...exempt('anything' as PrivateChatExemption) })).toContain(HOME_LINE)
  // Tool arguments are JSON. The mark does not survive it, and no string key stands in for it.
  expect(JSON.parse(JSON.stringify(exempt('pairing')))).toEqual({})
  for (const forged of [
    { exempt: 'pairing' }, { exemption: 'pairing' }, { 'private-chat-exemption': 'pairing' },
    { 'Symbol(private-chat-exemption)': 'pairing' }, JSON.parse(JSON.stringify(exempt('pairing'))),
  ]) {
    expect(await passes('sendMessage', { chat_id: MONTY, text: 'x', ...forged })).toContain(HOME_LINE)
  }
})

test('private chat: the exemptions are exactly the named six, each with its reason', () => {
  // Adding a way into a private chat means adding a row here and in the table.
  expect(Object.keys(PRIVATE_CHAT_EXEMPTIONS).sort()).toEqual(['dm-command', 'pairing', 'permission-relay', 'pin-release', 'tap-answer', 'wake-ack'])
  for (const row of Object.values(PRIVATE_CHAT_EXEMPTIONS)) {
    expect(row.reason.length).toBeGreaterThan(40)
    expect(row.methods.length).toBeGreaterThan(0)
  }
})

test("private chat: through grammy's own Api, a DM send is refused before any request and a marked one goes out unmarked", async () => {
  const wire: Array<{ method: string; payload: Record<string, unknown> }> = []
  const api = new Api('123456:TEST-ONLY-fixture-token-never-live')
  // Installed first, so it is innermost: it answers every call and never calls prev. No request leaves.
  api.config.use(async (_prev, method, payload) => {
    wire.push({ method, payload: JSON.parse(JSON.stringify(payload)) })
    return { ok: true, result: { message_id: 1 } } as never
  })
  api.config.use(refusePrivateChat as never)
  await expect(api.sendMessage(MONTY, 'hi')).rejects.toThrow(HOME_LINE)
  await expect(api.setMessageReaction(MONTY, 5, [{ type: 'emoji', emoji: '👀' }])).rejects.toThrow(HOME_LINE)
  await expect(api.editMessageText(MONTY, 5, 'x')).rejects.toThrow(HOME_LINE)
  await expect(api.sendChatAction(MONTY, 'typing')).rejects.toThrow(HOME_LINE)
  expect(wire).toEqual([])
  await api.sendMessage(GROUP, 'hi', { message_thread_id: 40 })
  await api.sendMessage(STRANGER, 'Pairing required', exempt('pairing'))
  await api.unpinChatMessage(MONTY, 77, exempt('pin-release'))
  expect(wire).toEqual([
    { method: 'sendMessage', payload: { chat_id: GROUP, text: 'hi', message_thread_id: 40 } },
    { method: 'sendMessage', payload: { chat_id: STRANGER, text: 'Pairing required' } },
    { method: 'unpinChatMessage', payload: { chat_id: MONTY, message_id: 77 } },
  ])
})

// --- the wiring ---------------------------------------------------------------------

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')

test('private chat: the server and wake-check install the refusal on their API, and every exemption a call site names is in the table', () => {
  const server = src('server.ts')
  const wake = src('wake-check.ts')
  expect(server).toContain('bot.api.config.use(refusePrivateChat as Transformer)')
  expect(wake).toContain('api.config.use(refusePrivateChat as Transformer)')
  // The tools' gate is the shared one, and only unpin_message is wired with an exemption.
  expect(server).toContain('function assertAllowedChat(chat_id: string): void {\n  assertOutboundChat(loadAccess(), chat_id, ACCESS_CMD)\n}')
  expect(server.match(/assertOutboundChat\(loadAccess\(\), chat_id, ACCESS_CMD, '([a-z-]+)'\)/g)).toEqual(["assertOutboundChat(loadAccess(), chat_id, ACCESS_CMD, 'pin-release')"])
  expect(server).toContain("return await runReact({ api: bot.api, assertAllowedChat }, args)")
  const named = (s: string) => [...s.matchAll(/exempt\('([^']+)'\)/g)].map(m => m[1])
  for (const n of [...named(server), ...named(wake)]) expect(Object.keys(PRIVATE_CHAT_EXEMPTIONS)).toContain(n)
  // Every row is used by a call site, so the table lists no way in that nothing takes.
  expect([...new Set([...named(server), ...named(wake)])].sort()).toEqual(Object.keys(PRIVATE_CHAT_EXEMPTIONS).sort())
  // The two tap answers that an end-to-end run cannot reach without his real desktop or a real alert.
  expect(server).toContain("const sent = await bot.api.sendMessage(chat_id, text, { ...(thread_id != null ? { message_thread_id: thread_id } : {}), ...exempt('tap-answer') })")
  // The agent is told, in the instructions it reads at launch.
  expect(server).toContain("'Monty\\'s DM is not a work channel. A message from a private chat (a positive chat_id) still reaches you, but reply, react, edit_message and pin_message are refused there.")
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
        case 'getChatMember':
          return reply(200, { ok: true, result: { status: 'administrator', can_pin_messages: true, user: { id: 42, is_bot: true, first_name: 'Testy' } } })
      }
      return reply(200, { ok: true, result: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    of: (method: string) => calls.filter(c => c.method === method),
    /** Every call that names a chat, as [method, chat_id]. */
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

async function startBridge(stub: ReturnType<typeof startStub>, opts: { dmPolicy?: string; pins?: object[]; andonAnswer?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'private-chat-e2e-'))
  const state = join(home, 'state')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'access.json'), JSON.stringify({
    dmPolicy: opts.dmPolicy ?? 'allowlist', allowFrom: [MONTY], pending: {},
    groups: { [GROUP]: { requireMention: true, allowFrom: [], threads: { '40': { requireMention: false } } } },
  }))
  if (opts.pins) writeFileSync(join(state, 'pins.json'), JSON.stringify({ pins: opts.pins }))
  const stubBin = (name: string, script: string) => { const p = join(home, name); writeFileSync(p, script); chmodSync(p, 0o755); return p }
  const interrupt = stubBin('interrupt', '#!/bin/sh\nexit 0\n')
  const andon = stubBin('fleet-andon', `#!/bin/sh\necho '${opts.andonAnswer ?? '{"ok":true,"toast":"Taken"}'}'\n`)
  const p = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TELEGRAM_STATE_DIR: state,
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
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'private-chat-test', version: '0' } } })
  // 20s: under a full `bun test` the subprocess can take over 10s to start.
  await until(() => lines().find(m => m.id === 1), 20_000)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await until(() => err.includes(`polling as @${BOT}`), 20_000)
  return {
    home, state, call, send,
    stderr: () => err,
    events: () => lines().filter(m => m.method === 'notifications/claude/channel').map(m => m.params),
    permissions: () => lines().filter(m => m.method === 'notifications/claude/channel/permission').map(m => m.params),
    pins: () => { try { return JSON.parse(readFileSync(join(state, 'pins.json'), 'utf8')).pins as Array<{ message_id: number }> } catch { return [] } },
    kill: () => p.kill('SIGKILL'),
  }
}

const monty = { id: Number(MONTY), is_bot: false, first_name: 'Monty', username: 'monty' }
const stranger = { id: Number(STRANGER), is_bot: false, first_name: 'Sam', username: 'sam' }
const dmChat = (who: typeof monty) => ({ id: who.id, type: 'private', first_name: who.first_name })
const fleet = { id: Number(GROUP), type: 'supergroup', title: 'Fleet', is_forum: true }
let nextInbound = 7000
const dm = (text: string, who = monty, extra: object = {}) => ({ message: { message_id: nextInbound++, date: 1, chat: dmChat(who), from: who, text, ...extra } })
const command = (text: string, who = monty) => dm(text, who, { entities: [{ type: 'bot_command', offset: 0, length: text.length }] })
const tap = (message_id: number, data: string, keyboard: object[][], text = 'Pick one') => ({
  callback_query: {
    id: `cq-${message_id}-${data}`, from: monty, chat_instance: 'ci', data,
    message: { message_id, date: 1, chat: dmChat(monty), text, reply_markup: { inline_keyboard: keyboard } },
  },
})

test('end to end: reply, edit_message, react and pin_message to his DM come back as the refusal and ask Telegram nothing; the same in the FLEET group go out', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub)
  for (const [tool, args] of [
    ['reply', { chat_id: MONTY, text: QUESTION }],
    ['reply', { chat_id: MONTY, text: 'with buttons', reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'x:yes', style: 'success' }]] } }],
    ['edit_message', { chat_id: MONTY, message_id: '50', text: 'edited' }],
    ['react', { chat_id: MONTY, message_id: '50', emoji: '👀' }],
    ['pin_message', { chat_id: MONTY, message_id: '50' }],
  ] as const) {
    const r = await bridge.call(tool, args)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`${tool} failed: ${HOME_LINE}`)
  }
  expect(stub.into(MONTY)).toEqual([])

  const sent = await bridge.call('reply', { chat_id: GROUP, text: QUESTION, message_thread_id: 40 })
  expect(sent.isError).toBeUndefined()
  const id = /id: (\d+)/.exec(sent.content[0].text)![1]
  expect((await bridge.call('edit_message', { chat_id: GROUP, message_id: id, text: QUESTION })).isError).toBeUndefined()
  expect((await bridge.call('react', { chat_id: GROUP, message_id: id, emoji: '👀' })).content[0].text).toBe('reacted')
  expect((await bridge.call('pin_message', { chat_id: GROUP, message_id: id })).isError).toBeUndefined()
  expect(stub.into(GROUP).filter(m => m !== 'getChatMember')).toEqual(['sendMessage', 'editMessageText', 'setMessageReaction', 'pinChatMessage'])
  expect(stub.into(MONTY)).toEqual([])
  bridge.kill()
})

test('end to end: his DM still reaches the session, and the bridge posts nothing into it, not even "typing"; a group post still shows typing', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub)
  const u = dm('are you there?')
  stub.push(u)
  const ev = await until(() => bridge.events().find(e => e.content === 'are you there?'))
  expect(ev.meta.chat_id).toBe(MONTY)
  expect(ev.meta.message_id).toBe(String(u.message.message_id))
  stub.push({ message: { message_id: nextInbound++, date: 1, chat: fleet, from: monty, message_thread_id: 40, is_topic_message: true, text: 'and here?' } })
  await until(() => bridge.events().some(e => e.content === 'and here?'))
  await until(() => stub.of('sendChatAction').length >= 1)
  expect(stub.of('sendChatAction').map(c => String(c.body.chat_id))).toEqual([GROUP])
  expect(stub.into(MONTY)).toEqual([])
  bridge.kill()
})

test('end to end, exemptions: pairing and the DM commands still answer in the DM', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, { dmPolicy: 'pairing' })
  const texts = (chat: string) => stub.of('sendMessage').filter(c => String(c.body.chat_id) === chat).map(c => c.body.text as string)

  // dm-command: /start, /help and /status, to him and to a stranger.
  stub.push(command('/start'))
  await until(() => texts(MONTY).length === 1)
  stub.push(command('/help'))
  await until(() => texts(MONTY).length === 2)
  stub.push(command('/status'))
  await until(() => texts(MONTY).length === 3)
  expect(texts(MONTY)[0]).toContain('This bot bridges Telegram to a Claude Code session.')
  expect(texts(MONTY)[1]).toContain('Messages you send here route to a paired Claude Code session.')
  expect(texts(MONTY)[2]).toBe('Paired as @monty.')
  stub.push(command('/status', stranger))
  await until(() => texts(STRANGER).length === 1)
  expect(texts(STRANGER)[0]).toBe('Not paired. Send me a message to get a pairing code.')

  // pairing: the code goes to the stranger's DM, /status repeats it there, and approval is confirmed there.
  stub.push(dm('let me in', stranger))
  await until(() => texts(STRANGER).length === 2)
  expect(texts(STRANGER)[1]).toContain('Pairing required')
  stub.push(command('/status', stranger))
  await until(() => texts(STRANGER).length === 3)
  expect(texts(STRANGER)[2]).toContain('Pending pairing')
  mkdirSync(join(bridge.state, 'approved'), { recursive: true })
  writeFileSync(join(bridge.state, 'approved', STRANGER), '')
  await until(() => texts(STRANGER).length === 4, 15_000)
  expect(texts(STRANGER)[3]).toBe('Paired! Say hi to Claude.')
  // None of it reached the session as chat, and nothing was refused on the way.
  expect(bridge.events()).toEqual([])
  expect(bridge.stderr()).not.toContain('not a work channel')
  bridge.kill()
})

test('end to end, exemptions: a permission prompt goes to his DM, and his tap and his typed yes are marked there', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub)
  const ask = (request_id: string) => bridge.send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id, tool_name: 'Bash', description: 'run a command', input_preview: '{"command":"ls"}' } })
  ask('abcde')
  await until(() => stub.of('sendMessage').length === 1)
  expect(stub.of('sendMessage')[0].body).toMatchObject({ chat_id: MONTY, text: '🔐 Permission: Bash' })
  const kb = stub.of('sendMessage')[0].body.reply_markup.inline_keyboard

  stub.push(tap(5000, 'perm:more:abcde', kb, '🔐 Permission: Bash'))
  await until(() => stub.of('editMessageText').length === 1)
  expect(stub.of('editMessageText')[0].body.text).toContain('description: run a command')
  stub.push(tap(5000, 'perm:allow:abcde', kb, '🔐 Permission: Bash'))
  await until(() => stub.of('editMessageText').length === 2)
  expect(stub.of('editMessageText')[1].body).toMatchObject({ chat_id: Number(MONTY), message_id: 5000, text: '🔐 Permission: Bash\n\n✅ Allowed' })

  ask('fghij')
  await until(() => stub.of('sendMessage').length === 2)
  const typed = dm('yes fghij')
  stub.push(typed)
  await until(() => stub.of('setMessageReaction').length === 1)
  expect(stub.of('setMessageReaction')[0].body).toMatchObject({ chat_id: MONTY, message_id: typed.message.message_id, reaction: [{ type: 'emoji', emoji: '✅' }] })
  expect(bridge.permissions()).toEqual([{ request_id: 'abcde', behavior: 'allow' }, { request_id: 'fghij', behavior: 'allow' }])
  bridge.kill()
})

test('end to end, exemptions: a tap in his DM is marked on the tapped message and an alert tap is answered under it', async () => {
  const stub = startStub()
  const bridge = await startBridge(stub, { andonAnswer: '{"ok":true,"toast":"Shown","reply":"Run: fleet-andon --list"}' })
  // tap-answer, the mark: a generic button standing in his DM freezes on his tap.
  const kb = [[{ text: 'Yes', callback_data: 'grady:yes', style: 'success' }, { text: 'No', callback_data: 'grady:no', style: 'danger' }]]
  stub.push(tap(50, 'grady:yes', kb))
  await until(() => stub.of('editMessageReplyMarkup').length === 1)
  expect(stub.of('editMessageReplyMarkup')[0].body).toMatchObject({ chat_id: Number(MONTY), message_id: 50 })
  // tap-answer, the line: an alert button standing in his DM is answered under the alert.
  stub.push(tap(51, 'al:fx:maxi:abcdef', [[{ text: 'Show fix', callback_data: 'al:fx:maxi:abcdef', style: 'primary' }]], 'An alert'))
  await until(() => stub.of('sendMessage').length === 1)
  expect(stub.of('sendMessage')[0].body).toMatchObject({ chat_id: MONTY, text: 'Run: fleet-andon --list', reply_parameters: { message_id: 51 } })
  bridge.kill()
})

test('end to end, exemptions: a pin already standing in his DM comes down by unpin_message and by his reply', async () => {
  const stub = startStub()
  const pin = (message_id: number) => ({ chat_id: MONTY, thread_id: null, message_id, pinned_at: new Date().toISOString(), question: QUESTION })
  const bridge = await startBridge(stub, { pins: [pin(77), pin(78)] })
  const r = await bridge.call('unpin_message', { chat_id: MONTY, message_id: '77' })
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toBe('unpinned (id: 77)')
  expect(stub.of('unpinChatMessage').map(c => c.body)).toEqual([{ chat_id: MONTY, message_id: 77 }])
  stub.push(dm('Tonight.', monty, { reply_to_message: { message_id: 78, date: 1, chat: dmChat(monty), from: { id: 42, is_bot: true, first_name: 'Testy', username: BOT } } }))
  await until(() => stub.of('unpinChatMessage').length === 2)
  expect(stub.of('unpinChatMessage')[1].body).toEqual({ chat_id: MONTY, message_id: 78 })
  await until(() => bridge.pins().length === 0)
  // A new pin in the DM is still refused.
  const again = await bridge.call('pin_message', { chat_id: MONTY, message_id: '78' })
  expect(again.content[0].text).toBe(`pin_message failed: ${HOME_LINE}`)
  expect(stub.of('pinChatMessage')).toEqual([])
  bridge.kill()
})
