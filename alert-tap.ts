/**
 * Alert buttons and the thumbs-down hand-off, served by the bridge itself.
 *
 * Spec: agents/Grady/design/SPEC-alerts-through-page-2026-11-20 (build step 3
 * and its amendment, the aged-wait buttons).
 *
 * WHY SERVER-SIDE. Same reason as the omf: tap. A tap handed to the agent
 * waits for that agent's next turn, and an alert must be answerable when
 * Page's session is asleep, busy or down. So the bridge runs one command per
 * tap and acts on what it prints.
 *
 * THE BRIDGE HOLDS NO ALERT STATE. The latch lives with fleet-andon on the
 * host that raised the alert; the wait lives with the aged-wait sender. Each
 * answers `--tap <verb> --id <id>` with ONE JSON object, and this file does
 * only what that object says:
 *
 *   { ok, toast, key, button,
 *     reply?: string,                       // posted under the tapped message
 *     talk?:  { owner: string, text: string } }  // "Talk to <owner>"
 *
 * Callback data, 64 bytes at most:
 *   al:<verb>:<host>:<id>   an alert      verb: ig s1 s4 s9 fx tk
 *   aw:<verb>:<id>          an aged wait  verb: dn sm nn tk
 * "Open doc" is not here: it is an ordinary omf: button.
 *
 * EVERY TAP IS LOGGED with the alert key and the button, one JSON line. A
 * wait counts as having reached Monty only when he taps one of its buttons
 * (Taiichi's measure), and this log is what that reading counts.
 *
 * Kept out of server.ts because importing server.ts starts the bot.
 */

import { spawn } from 'child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export const FLEET_ANDON_BIN = process.env.ALERT_TAP_ANDON ?? join(homedir(), '.local', 'bin', 'fleet-andon')
export const AGED_WAIT_BIN = process.env.ALERT_TAP_AGED_WAIT ?? join(homedir(), '.local', 'bin', 'post-aged-waits-on-monty')
export const TAP_LOG = process.env.ALERT_TAP_LOG ?? join(homedir(), '.claude', 'logs', 'alert-taps.jsonl')
export const TOPICS_FILE = process.env.PAGE_TOPICS_FILE ?? join(homedir(), 'dev', 'agents', 'agents', 'Page', 'topics.json')
export const TAP_TIMEOUT_MS = 12_000
export const LOOKUP_TIMEOUT_MS = 20_000
export const DISPATCH_TIMEOUT_MS = 20_000
export const TOAST_MAX = 200
/** The agent a thumbs-down goes to. */
export const THUMBS_DOWN_TO = 'Grady'
export const ALERT_TOPICS = ['p0_alerts', 'fleet_notifications'] as const

/** Like tag-relay's Runner, with stdout: the command's answer is on it. */
export type OutRunner = (argv: string[], stdin: string | undefined, timeoutMs: number) => Promise<{ rc: number; stdout: string; stderr: string }>

export type AlertTap =
  | { kind: 'al'; verb: string; host: string; id: string }
  | { kind: 'aw'; verb: string; id: string }

const AL_VERBS = new Set(['ig', 's1', 's4', 's9', 'fx', 'tk'])
const AW_VERBS = new Set(['dn', 'sm', 'nn', 'tk'])

/** Parse callback data. Anything that is not exactly one of the two forms is not ours. */
export function parseAlertTap(data: string): AlertTap | undefined {
  const al = /^al:([a-z0-9]{2}):([A-Za-z0-9-]{1,20}):([0-9a-f]{6,16})$/.exec(data)
  if (al && AL_VERBS.has(al[1])) return { kind: 'al', verb: al[1], host: al[2], id: al[3] }
  const aw = /^aw:([a-z]{2}):([0-9a-f]{6,16})$/.exec(data)
  if (aw && AW_VERBS.has(aw[1])) return { kind: 'aw', verb: aw[1], id: aw[2] }
  return undefined
}

export function tapArgv(tap: AlertTap): string[] {
  return tap.kind === 'al'
    ? [FLEET_ANDON_BIN, '--tap', tap.verb, '--id', tap.id, '--tap-host', tap.host]
    : [AGED_WAIT_BIN, '--tap', tap.verb, '--id', tap.id]
}

export type TapAnswer = {
  ok?: boolean
  toast?: string
  key?: string
  button?: string
  reply?: string
  talk?: { owner?: string; text?: string }
}

/** The command's last JSON line, or undefined when it printed none. */
export function parseAnswer(stdout: string): TapAnswer | undefined {
  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))
  for (const l of lines.reverse()) {
    try {
      const o = JSON.parse(l)
      if (o && typeof o === 'object') return o as TapAnswer
    } catch {}
  }
  return undefined
}

export type Topics = { chat_id?: string; owner?: string; threads: Record<string, number | undefined> }

/** Page's topic record. The ids are read here on every use and written nowhere in this repo. */
export function readTopics(file: string = TOPICS_FILE, read: (f: string) => string = f => readFileSync(f, 'utf8')): Topics | undefined {
  try {
    const d = JSON.parse(read(file))
    const threads: Record<string, number | undefined> = {}
    for (const [k, v] of Object.entries(d.topics ?? {})) {
      const id = (v as { thread_id?: unknown })?.thread_id
      threads[k] = typeof id === 'number' && id > 0 ? id : undefined
    }
    return { chat_id: d.chat_id != null ? String(d.chat_id) : undefined, owner: typeof d.owner === 'string' ? d.owner : undefined, threads }
  } catch {
    return undefined
  }
}

export type Sent = { message_id: number }

export type AlertTapDeps = {
  run: OutRunner
  /** Post into a chat; thread and reply target are optional. */
  send: (chat_id: string, text: string, opts: { thread_id?: number; reply_to?: number }) => Promise<Sent>
  topics: () => Topics | undefined
  /** The tag relay: delivers a post that tags another agent's bot to that agent. */
  relay?: (req: { chat_id: string; thread_id?: number; posts: Array<{ message_id: number; text: string }> }) => unknown
  log: (entry: Record<string, unknown>) => void
  stderr: (s: string) => void
  now?: () => Date
}

export type TappedMessage = { chat_id?: string; thread_id?: number; message_id?: number; user_id: string }

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of Array.from(s)) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}

/**
 * Serve one tap. Returns the toast for answerCallbackQuery and whether the
 * command said the tap took; never rejects.
 * The toast is returned BEFORE any follow-up post is awaited by the caller:
 * `after` is the follow-up work (the fix reply, the talk post), which the
 * caller runs without making him wait on it.
 */
export async function serveAlertTap(deps: AlertTapDeps, tap: AlertTap, msg: TappedMessage): Promise<{ toast: string; ok: boolean; after: Promise<void> }> {
  const now = deps.now ?? (() => new Date())
  const argv = tapArgv(tap)
  let r: { rc: number; stdout: string; stderr: string }
  try {
    r = await deps.run(argv, undefined, TAP_TIMEOUT_MS)
  } catch (e) {
    r = { rc: 127, stdout: '', stderr: String(e) }
  }
  const answer = parseAnswer(r.stdout)
  const entry: Record<string, unknown> = {
    ts: now().toISOString(),
    kind: tap.kind,
    key: answer?.key ?? null,
    button: answer?.button ?? tap.verb,
    id: tap.id,
    host: tap.kind === 'al' ? tap.host : null,
    ok: answer?.ok === true,
    rc: r.rc,
    chat_id: msg.chat_id ?? null,
    thread_id: msg.thread_id ?? null,
    message_id: msg.message_id ?? null,
    user_id: msg.user_id,
  }
  try { deps.log(entry) } catch (e) { deps.stderr(`alert tap: log write failed: ${e}\n`) }

  if (!answer) {
    deps.stderr(`alert tap: ${argv.join(' ')} gave no answer: rc=${r.rc} ${r.stderr}\n`)
    const why = r.rc === 124 ? 'timed out' : `exit ${r.rc}`
    return { toast: clip(`⚠ That didn't work (${why}).`, TOAST_MAX), ok: false, after: Promise.resolve() }
  }
  const toast = clip(answer.toast || (answer.ok ? 'Done.' : "⚠ That didn't work."), TOAST_MAX)
  const after = (async () => {
    try {
      if (answer.reply && msg.chat_id) {
        await deps.send(msg.chat_id, answer.reply, { thread_id: msg.thread_id, reply_to: msg.message_id })
      }
      if (answer.talk?.owner && msg.chat_id) {
        await postTalk(deps, { owner: answer.talk.owner, text: answer.talk.text ?? '' }, msg)
      }
    } catch (e) {
      deps.stderr(`alert tap: follow-up post failed: ${e}\n`)
    }
  })()
  // ok: the command said the tap took. The caller marks the button only then.
  return { toast, ok: answer.ok === true, after }
}

/** `Vera` -> `MK_VeraBot`, the form the tag relay recognizes. */
export function ownerBot(owner: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(owner) ? `MK_${owner}Bot` : undefined
}

/**
 * "Talk to <owner>": post the alert in Page's Alerts resolution topic, tagging
 * the owner, and relay the tag so the owner is told. The owner runs the
 * conversation there; Page does not answer for it.
 *
 * NO TOPIC YET, OR THE POST REFUSED: the same line is posted as a reply under
 * the alert itself. The tap never ends in silence for want of a topic.
 */
export async function postTalk(deps: AlertTapDeps, talk: { owner: string; text: string }, msg: TappedMessage): Promise<'resolution' | 'under-alert' | 'failed'> {
  const bot = ownerBot(talk.owner)
  const text = `${bot ? `@${bot}` : talk.owner} Monty wants to talk about this alert: ${talk.text}`
  const topics = deps.topics()
  const thread = topics?.threads['alerts_resolution']
  if (topics?.chat_id && thread != null) {
    try {
      const sent = await deps.send(topics.chat_id, text, { thread_id: thread })
      deps.relay?.({ chat_id: topics.chat_id, thread_id: thread, posts: [{ message_id: sent.message_id, text }] })
      return 'resolution'
    } catch (e) {
      deps.stderr(`alert tap: the post into Alerts resolution was refused, replying under the alert instead: ${e}\n`)
    }
  } else {
    deps.stderr('alert tap: no Alerts resolution topic in Page\'s topic record; replying under the alert instead\n')
  }
  if (!msg.chat_id) return 'failed'
  try {
    const sent = await deps.send(msg.chat_id, text, { thread_id: msg.thread_id, reply_to: msg.message_id })
    deps.relay?.({ chat_id: msg.chat_id, thread_id: msg.thread_id, posts: [{ message_id: sent.message_id, text }] })
    return 'under-alert'
  } catch (e) {
    deps.stderr(`alert tap: talk post not sent: ${e}\n`)
    return 'failed'
  }
}

// --- thumbs-down ---------------------------------------------------------------

export type ThumbsDownDeps = {
  run: OutRunner
  topics: () => Topics | undefined
  /** This bridge's agent, as the claude() wrapper verified it, or '<Agent>'. */
  agent: string
  log: (entry: Record<string, unknown>) => void
  stderr: (s: string) => void
  /** Message ids already handed off, so a re-added reaction is not a second dispatch. */
  seen: Set<string>
  dispatch?: string
  now?: () => Date
}

export type MessageInfo = { found?: boolean; key?: string; text?: string; topic?: string; host?: string; legacy_caller?: boolean }

/**
 * A 👎 from Monty on a message in one of the two alert topics becomes ONE
 * `dispatch send` to Grady carrying the alert's key, text and topic. Returns
 * true when the reaction was an alert thumbs-down (handed off, or already
 * handed off), so the caller does not also surface it to the agent: Page's
 * charter says a thumbs-down is Grady's, and two hand-offs would be two.
 *
 * ONLY THE TOPICS' OWNER DOES THIS. Every bot in the group is sent every
 * reaction, so without this check one thumbs-down would be seven dispatches.
 *
 * The reaction update carries a chat and a message id and nothing else, so
 * `fleet-andon --message-info` turns the pair back into the alert. A message
 * it does not know, or one outside the two alert topics, is not ours.
 */
export async function handleThumbsDown(
  deps: ThumbsDownDeps,
  r: { chat_id: string; message_id: number; emoji: string; action: string; user_id: string },
): Promise<boolean> {
  if (r.emoji !== '👎' || r.action !== 'added') return false
  const topics = deps.topics()
  if (!topics?.chat_id || topics.chat_id !== r.chat_id) return false
  if (!topics.owner || topics.owner !== deps.agent) return false
  const seenKey = `${r.chat_id}/${r.message_id}`
  if (deps.seen.has(seenKey)) return true

  let info: MessageInfo | undefined
  try {
    const looked = await deps.run([FLEET_ANDON_BIN, '--message-info', '--chat', r.chat_id, '--message-id', String(r.message_id)], undefined, LOOKUP_TIMEOUT_MS)
    info = parseAnswer(looked.stdout) as MessageInfo | undefined
  } catch (e) {
    deps.stderr(`thumbs-down: lookup failed: ${e}\n`)
  }
  if (!info?.found || !(ALERT_TOPICS as readonly string[]).includes(info.topic ?? '')) return false
  if (deps.seen.has(seenKey)) return true
  deps.seen.add(seenKey)

  const now = deps.now ?? (() => new Date())
  const key = info.key || '(none: sent straight through notify-monty, no fleet-andon key)'
  const body = [
    'Monty put a thumbs-down on an alert.',
    '',
    `- key: ${key}`,
    `- topic: ${info.topic}`,
    `- raised on: ${info.host ?? '(unknown host)'}`,
    `- chat_id: ${r.chat_id}`,
    `- message_id: ${r.message_id}`,
    `- caller states a consequence: ${info.legacy_caller ? 'NO (its title was used as the line)' : 'yes'}`,
    '',
    '## The alert as he saw it',
    '',
    info.text ?? '',
    '',
  ].join('\n')
  const sent = await deps.run([
    deps.dispatch ?? 'dispatch', 'send',
    '--to', `agent:${THUMBS_DOWN_TO}`,
    '--from', deps.agent,
    '--tier', '2',
    '--subject', `Thumbs-down on an alert: ${clip(key, 80)}`,
    '--body', '-',
  ], body, DISPATCH_TIMEOUT_MS).catch(e => ({ rc: 127, stdout: '', stderr: String(e) }))
  if (sent.rc !== 0) {
    deps.seen.delete(seenKey)
    deps.stderr(`thumbs-down: dispatch to ${THUMBS_DOWN_TO} failed (rc=${sent.rc}): ${sent.stderr.trim().split('\n').pop() ?? ''}\n`)
  }
  try {
    deps.log({
      ts: now().toISOString(), kind: 'thumbs-down', key: info.key ?? null, button: 'thumbs-down',
      topic: info.topic, host: info.host ?? null, ok: sent.rc === 0, rc: sent.rc,
      chat_id: r.chat_id, message_id: r.message_id, user_id: r.user_id,
    })
  } catch (e) { deps.stderr(`thumbs-down: log write failed: ${e}\n`) }
  return true
}

// --- the real runner and log ------------------------------------------------------

export const spawnOutRunner: OutRunner = (argv, stdin, timeoutMs) =>
  new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (rc: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ rc, stdout, stderr }) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ rc: 127, stdout: '', stderr: String(e) })
      return
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(124) }, timeoutMs)
    child.stdout?.on('data', d => { if (stdout.length < 16384) stdout += String(d) })
    child.stderr?.on('data', d => { if (stderr.length < 4096) stderr += String(d) })
    child.on('error', e => { stderr += String(e); finish(127) })
    child.on('close', code => finish(code ?? 1))
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin ?? '')
  })

/** Append one line to the tap log. Local disk only; a failure throws to the caller, which reports and carries on. */
export function appendTapLog(entry: Record<string, unknown>, file: string = TAP_LOG): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
}
