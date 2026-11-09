#!/usr/bin/env bun
/**
 * wake-check.ts <Agent>: does this on-call agent's bot hold an update its
 * bridge would deliver? Run by fleet-supervisor only while the agent's bridge
 * is down, under a 15 s bound.
 *
 * Spec: agents/Grady/design/SPEC-on-call-agents-wake-and-sleep-2026-11-09,
 * "The wake check".
 *
 *   exit 10  an update the bridge would DELIVER is pending: wake the agent.
 *            It is left unconfirmed, so the woken bridge receives it in full,
 *            and "One moment, I'm on my way." is posted once in its chat and
 *            thread (deduped on update id in ~/.agents/<Agent>/tmp/wake-ack.json).
 *   exit 0   nothing deliverable is pending.
 *   exit 3   the peek failed (or could not finish in time): do not wake.
 *   exit 4   refused: a server.ts for this agent's state directory is running.
 *   exit 2   usage.
 *
 * THE PEEK. getUpdates with timeout 0 and no offset returns pending updates
 * without confirming them. Each update, oldest first, goes through the
 * bridge's own decision code (inbound-gate.ts, group-gate.ts,
 * invite-excuse.ts), imported, not reimplemented. An update the bridge would
 * drop is written to the post log with delivered:false, the line the bridge
 * writes, and confirmed, which is what the bridge does with it anyway: that is
 * what keeps a mention from being buried behind Telegram's 100-update page.
 *
 * THE TOKEN is read from the agent's own channel env file, parsed as server.ts
 * parses it, inside this process. It is never printed. Unlike server.ts, a
 * TELEGRAM_* value in the caller's environment does not override the file: the
 * caller is the supervisor, not that agent's bridge launch, and an inherited
 * token would peek the wrong bot. Errors print by class and Telegram's own
 * description only.
 *
 * NEVER BESIDE A LIVE POLLER. A second getUpdates against a polling bot gets
 * 409 and can disturb the live one. The supervisor gates on probe_bot, and
 * this refuses on its own as well. If it cannot tell, it refuses.
 */

import { Api, Context, GrammyError, HttpError } from 'grammy'
import type { Update, UserFromGetMe } from 'grammy/types'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { ALLOWED_UPDATES, inboundDecision, inboundText, parseEnvFile, type GateAccess } from './inbound-gate.ts'
import { planGroupCommand, type CommandDeps } from './invite-excuse.ts'
import { makeTee, outEntry, safeTee, teeInbound, isGroupChatId, TEE_DIR, type Tee } from './post-log.ts'

export const EXIT = { NOTHING: 0, USAGE: 2, PEEK_FAILED: 3, REFUSED: 4, DELIVER: 10 } as const

export const ACK_TEXT = "One moment, I'm on my way."

/** The commands server.ts registers with bot.command(); those never reach handleInbound. */
export const BRIDGE_COMMANDS = ['start', 'help', 'status']

/** Inside the supervisor's 15 s bound, with room to exit cleanly. */
const DEADLINE_MS = 12_000

type TeeArgs = Parameters<typeof teeInbound>[0]

export type Verdict =
  | { action: 'deliver'; why: string; ack: { chat_id: string; thread_id?: number } }
  | { action: 'drop'; why: string; tee?: Omit<TeeArgs, 'tee'> }

export type ClassifyEnv = {
  me: UserFromGetMe
  access: GateAccess & { pending?: unknown }
  agent: string
  isStatic: boolean
}

/**
 * What the bridge would do with one update, routed as server.ts routes it:
 * bot.command() first, then the message handlers into handleInbound (the
 * /invite plan, then gate()), then callback_query:data, then message_reaction.
 * Anything without a handler there is dropped and logged by nobody.
 */
export function classifyUpdate(update: Update, env: ClassifyEnv): Verdict {
  const ctx = new Context(update, {} as Api, env.me)
  const bot = env.me.username

  if (ctx.message) {
    const m = ctx.message
    const chat_id = String(m.chat.id)
    const thread_id = m.message_thread_id

    // bot.command('start'|'help'|'status'): answered by the bridge in a DM,
    // silently dropped anywhere else, and never logged.
    if (Context.has.command(BRIDGE_COMMANDS)(ctx)) {
      return m.chat.type === 'private' && inboundDecision(env.access, ctx, bot, env.agent) === 'deliver'
        ? { action: 'deliver', why: 'dm-command', ack: { chat_id, thread_id } }
        : { action: 'drop', why: 'command' }
    }

    const text = inboundText(m)
    if (text === undefined) return { action: 'drop', why: 'unhandled-kind' }
    const tee = { message: m, chat: m.chat, from: m.from, text }

    const deps = { agent: env.agent, botUsername: () => bot, loadAccess: () => env.access } as unknown as CommandDeps
    const plan = planGroupCommand(deps, { chat_id, chat_type: m.chat.type, from: m.from, text: m.text, message_thread_id: thread_id })
    if (plan.kind === 'act') return { action: 'deliver', why: plan.verb, ack: { chat_id, thread_id } }
    if (plan.kind === 'ignore') return { action: 'drop', why: 'command-not-mine', tee }

    const decision = inboundDecision(env.access, ctx, bot, env.agent)
    if (decision === 'deliver') {
      return { action: 'deliver', why: m.chat.type === 'private' ? 'dm' : 'group', ack: { chat_id, thread_id } }
    }
    return { action: 'drop', why: decision === 'pair' ? 'pairing' : 'gate', tee }
  }

  const cq = update.callback_query
  if (cq) {
    if (cq.data == null) return { action: 'drop', why: 'unhandled-update' }
    if (!env.access.allowFrom.includes(String(cq.from.id))) return { action: 'drop', why: 'button-not-allowed' }
    const msg = cq.message as { chat: { id: number }; message_thread_id?: number } | undefined
    return {
      action: 'deliver',
      why: 'button',
      ack: { chat_id: msg ? String(msg.chat.id) : String(cq.from.id), thread_id: msg?.message_thread_id },
    }
  }

  const r = update.message_reaction
  if (r) {
    const userId = String(r.user?.id ?? r.actor_chat?.id ?? '')
    if (!userId || !env.access.allowFrom.includes(userId)) return { action: 'drop', why: 'reaction-not-allowed' }
    return { action: 'deliver', why: 'reaction', ack: { chat_id: String(r.chat.id) } }
  }

  return { action: 'drop', why: 'unhandled-update' }
}

/** By class and Telegram's own description only: never a URL, never a payload. */
export function describeError(err: unknown): string {
  if (err instanceof GrammyError) return `GrammyError ${err.error_code}: ${err.description}`
  if (err instanceof HttpError) return 'HttpError: network request failed'
  return (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error'
}

export type PsRunner = (args: string[]) => { status: number | null; stdout: string }

const realPs: PsRunner = args => {
  const r = spawnSync('ps', args, { encoding: 'utf8', timeout: 5000 })
  return { status: r.status, stdout: r.stdout ?? '' }
}

const canon = (p: string) => {
  try { return realpathSync(p).toLowerCase() } catch { return p.toLowerCase() }
}

/**
 * Is a server.ts running with TELEGRAM_STATE_DIR naming this state dir?
 * The identity is in the process environment, not its command line, which is
 * why the supervisor reads `ps eww` too. Paths compare case-blind: the fleet's
 * dir casing does not agree, and the filesystem is case-insensitive.
 * 'unknown' when ps itself fails; the caller refuses on that.
 */
export function bridgeRunning(stateDir: string, ps: PsRunner = realPs, self = process.pid): boolean | 'unknown' {
  const list = ps(['-axww', '-o', 'pid=,command='])
  if (list.status !== 0) return 'unknown'
  const want = canon(stateDir)
  for (const line of list.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || Number(m[1]) === self || !/server\.ts\b/.test(m[2])) continue
    const env = ps(['eww', '-o', 'command=', '-p', m[1]])
    if (env.status !== 0) continue // it exited between the two calls
    for (const tok of env.stdout.split(/\s+/)) {
      if (tok.startsWith('TELEGRAM_STATE_DIR=') && canon(tok.slice('TELEGRAM_STATE_DIR='.length)) === want) return true
    }
  }
  return false
}

/** The supervisor's telegram_state_dir: the casing differs across the fleet, so resolve, never build. */
export function resolveStateDir(agent: string, root: string): string | undefined {
  const upper = agent.charAt(0).toUpperCase() + agent.slice(1)
  for (const cand of [`telegram-${agent}`, `telegram-${agent.toLowerCase()}`, `telegram-${upper}`]) {
    if (existsSync(join(root, cand))) return join(root, cand)
  }
  return undefined
}

/** server.ts's readAccessFile, minus its repair: a corrupt file is the bridge's to move aside, not ours. */
export function readAccess(file: string): GateAccess | 'corrupt' {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { dmPolicy: 'pairing', allowFrom: [], groups: {} }
    return 'corrupt'
  }
  try {
    const p = JSON.parse(raw) as Partial<GateAccess>
    return { dmPolicy: p.dmPolicy ?? 'pairing', allowFrom: p.allowFrom ?? [], groups: p.groups ?? {}, mentionPatterns: p.mentionPatterns }
  } catch {
    return 'corrupt'
  }
}

type AckRecord = { update_id: number; chat_id: string; thread_id: number | null; at: string }

/** Post the wait notice once per deliverable update. A failure is one stderr line: the wake matters more. */
async function acknowledge(
  api: Api,
  ackFile: string,
  update_id: number,
  ack: { chat_id: string; thread_id?: number },
  tee: Tee,
  err: (l: string) => void,
): Promise<'sent' | 'already' | 'failed'> {
  let prev: Partial<AckRecord> | undefined
  try { prev = JSON.parse(readFileSync(ackFile, 'utf8')) } catch {}
  if (prev?.update_id === update_id) return 'already'
  try {
    const sent = await api.sendMessage(ack.chat_id, ACK_TEXT, ack.thread_id != null ? { message_thread_id: ack.thread_id } : {})
    if (isGroupChatId(ack.chat_id)) {
      safeTee(tee, outEntry({ chat_id: ack.chat_id, thread_id: ack.thread_id, message_id: sent.message_id, text: ACK_TEXT, edit: false }))
    }
  } catch (e) {
    err(`wake-check: acknowledgement not sent: ${describeError(e)}\n`)
    return 'failed'
  }
  try {
    mkdirSync(join(ackFile, '..'), { recursive: true, mode: 0o700 })
    const rec: AckRecord = { update_id, chat_id: ack.chat_id, thread_id: ack.thread_id ?? null, at: new Date().toISOString() }
    writeFileSync(`${ackFile}.tmp`, JSON.stringify(rec) + '\n', { mode: 0o600 })
    renameSync(`${ackFile}.tmp`, ackFile)
  } catch (e) {
    err(`wake-check: acknowledgement sent but not recorded: ${describeError(e)}\n`)
  }
  return 'sent'
}

export async function main(argv: string[], io = {
  out: (l: string) => { process.stdout.write(l) },
  err: (l: string) => { process.stderr.write(l) },
}): Promise<number> {
  const agent = argv[0]
  if (argv.length !== 1 || !/^[A-Za-z][A-Za-z0-9]*$/.test(agent ?? '')) {
    io.err('usage: wake-check.ts <Agent>\n')
    return EXIT.USAGE
  }
  const started = Date.now()
  const fail = (what: string) => { io.err(`wake-check ${agent}: ${what}; not waking\n`); return EXIT.PEEK_FAILED }

  const root = process.env.FLEET_CHANNEL_ROOT ?? join(homedir(), '.claude', 'channels')
  const stateDir = resolveStateDir(agent, root)
  if (!stateDir) return fail(`no telegram state dir for ${agent} under ${root}`)

  const running = bridgeRunning(stateDir)
  if (running !== false) {
    io.err(`wake-check ${agent}: refused: ${running === true ? `a server.ts for ${basename(stateDir)} is running` : 'cannot list processes to rule out a live bridge'}\n`)
    return EXIT.REFUSED
  }

  let fileEnv: Record<string, string>
  try {
    fileEnv = parseEnvFile(readFileSync(join(stateDir, '.env'), 'utf8'))
  } catch (e) {
    return fail(`channel env file unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  const token = fileEnv.TELEGRAM_BOT_TOKEN
  if (!token) return fail('no TELEGRAM_BOT_TOKEN in the channel env file')
  const isStatic = fileEnv.TELEGRAM_ACCESS_MODE === 'static'

  const access = readAccess(join(stateDir, 'access.json'))
  if (access === 'corrupt') return fail('access.json unreadable')

  // WAKE_CHECK_API_ROOT exists for the stub API in the tests and nothing else.
  const api = new Api(token, {
    ...(process.env.WAKE_CHECK_API_ROOT ? { apiRoot: process.env.WAKE_CHECK_API_ROOT } : {}),
    timeoutSeconds: 8,
  })

  let me: UserFromGetMe
  try {
    me = await api.getMe()
  } catch (e) {
    return fail(`getMe failed: ${describeError(e)}`)
  }
  const tee = makeTee({ dir: TEE_DIR, bot: () => me.username, stderr: io.err })
  const env: ClassifyEnv = { me, access, agent, isStatic }
  const ackFile = join(homedir(), '.agents', agent, 'tmp', 'wake-ack.json')

  let offset: number | undefined
  let dropped = 0
  for (;;) {
    if (Date.now() - started > DEADLINE_MS) return fail(`scan incomplete after ${dropped} dropped updates`)
    let updates: Update[]
    try {
      // No offset on the first call: a peek confirms nothing. A later call's
      // offset confirms the page of drops before it, and peeks the next.
      updates = await api.getUpdates({ timeout: 0, allowed_updates: [...ALLOWED_UPDATES], ...(offset != null ? { offset } : {}) })
    } catch (e) {
      return fail(`getUpdates failed: ${describeError(e)}`)
    }
    if (updates.length === 0) {
      io.out(`wake-check ${agent}: nothing deliverable pending (${dropped} dropped and confirmed)\n`)
      return EXIT.NOTHING
    }
    updates.sort((a, b) => a.update_id - b.update_id)
    let dropsThisPage = 0
    for (const u of updates) {
      const v = classifyUpdate(u, env)
      if (v.action === 'deliver') {
        if (dropsThisPage > 0) {
          // Confirm the drops ahead of it and nothing else: the offset is the
          // deliverable update's own id, which leaves it pending.
          try {
            await api.getUpdates({ offset: u.update_id, limit: 1, timeout: 0, allowed_updates: [...ALLOWED_UPDATES] })
          } catch (e) {
            io.err(`wake-check ${agent}: drops ahead of update ${u.update_id} not confirmed: ${describeError(e)}\n`)
          }
        }
        const acked = await acknowledge(api, ackFile, u.update_id, v.ack, tee, io.err)
        io.out(`wake-check ${agent}: deliverable update ${u.update_id} (${v.why}), ack ${acked}; ${dropped} dropped and confirmed\n`)
        return EXIT.DELIVER
      }
      if (v.tee) teeInbound({ ...v.tee, tee }, () => ({ action: 'drop' }))
      dropsThisPage++
      dropped++
    }
    offset = updates[updates.length - 1].update_id + 1
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    e => { process.stderr.write(`wake-check: ${describeError(e)}; not waking\n`); process.exit(EXIT.PEEK_FAILED) },
  )
}
