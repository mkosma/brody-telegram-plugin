// SPEC-bridge-polls-only-after-initialized-2026-11-12: the bridge calls
// Telegram only after the MCP client has sent notifications/initialized, or
// after a bounded wait when it never does.
//
// End to end: the real server.ts runs as a subprocess, the test is its MCP
// client over stdio, and a local stub stands in for the Telegram API.

import { test, expect, afterAll, setDefaultTimeout } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Subprocesses, and revert-proofs.py runs the whole suite under load.
setDefaultTimeout(30_000)

const TOKEN = '123456:TEST-ONLY-fixture-token-never-live'
const BOT = 'MK_TestyBot'

type Call = { method: string; at: number }
const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups) c() })

function startStub() {
  const calls: Call[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname)
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (!m || m[1] !== TOKEN) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
      calls.push({ method: m[2], at: Date.now() })
      switch (m[2]) {
        case 'getMe':
          return reply(200, { ok: true, result: { id: 42, is_bot: true, first_name: 'Testy', username: BOT, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } })
        case 'getUpdates':
          // A short long-poll, so the loop does not spin.
          await Bun.sleep(200)
          return reply(200, { ok: true, result: [] })
      }
      return reply(200, { ok: true, result: true })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, calls, methods: () => calls.map(c => c.method) }
}

function startBridge(apiRoot: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'poll-gate-'))
  const spawnedAt = Date.now()
  const p = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TELEGRAM_STATE_DIR: join(home, 'state'),
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_API_ROOT: apiRoot,
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
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
  return {
    spawnedAt,
    stderr: () => err,
    send: (msg: object) => { p.stdin.write(JSON.stringify(msg) + '\n'); p.stdin.flush() },
    // The JSON-RPC response with this id, once the server has written it.
    response: (id: number) => until(() => out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === id)),
    kill: () => p.kill('SIGKILL'),
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

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'poll-gate-test', version: '0' } },
}
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' }
const TIMEOUT_LINE = 'client sent no initialized within'

test('poll gate: polling does not start before initialized, and starts after it', async () => {
  const stub = startStub()
  const bridge = startBridge(stub.url)
  bridge.send(INITIALIZE)
  const res = await bridge.response(1)
  expect(res.result.serverInfo.name).toBe('telegram')
  // The handshake is open: the server has answered initialize and the client
  // has not yet confirmed. An ungated bridge reaches Telegram well inside this.
  await Bun.sleep(1500)
  expect(stub.methods()).toEqual([])
  expect(bridge.stderr()).not.toContain('polling as')

  bridge.send(INITIALIZED)
  await until(() => stub.methods().includes('getUpdates'))
  await until(() => bridge.stderr().includes(`polling as @${BOT}`))
  expect(bridge.stderr()).not.toContain(TIMEOUT_LINE)
  bridge.kill()
})

test('poll gate: with no initialized, polling starts at the bound and says so on stderr', async () => {
  const BOUND = 400
  const stub = startStub()
  const bridge = startBridge(stub.url, { TELEGRAM_INIT_WAIT_MS: String(BOUND) })
  bridge.send(INITIALIZE)
  await bridge.response(1)
  await until(() => stub.methods().includes('getUpdates'))
  // Not before the bound: the first call to Telegram is at least BOUND after spawn.
  expect(stub.calls[0].at - bridge.spawnedAt).toBeGreaterThanOrEqual(BOUND)
  await until(() => bridge.stderr().includes(`polling as @${BOT}`))
  const said = bridge.stderr().split('\n').filter(l => l.includes(TIMEOUT_LINE))
  expect(said).toEqual([`telegram channel: client sent no initialized within ${BOUND}ms, polling anyway`])
  bridge.kill()
})

test('poll gate: the bound defaults to 30s, the client\'s own MCP connect timeout', async () => {
  const src = await Bun.file(join(import.meta.dir, 'server.ts')).text()
  expect(src).toContain('const INIT_WAIT_MS = Number(process.env.TELEGRAM_INIT_WAIT_MS) || 30_000')
  // The callback is set before connect(), or an early initialized is missed.
  expect(src.indexOf('mcp.oninitialized =')).toBeGreaterThan(-1)
  expect(src.indexOf('mcp.oninitialized =')).toBeLessThan(src.indexOf('await mcp.connect('))
})
