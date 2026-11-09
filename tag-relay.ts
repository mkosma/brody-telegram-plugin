/**
 * The tag relay: when this bridge's agent posts into a group and tags another
 * fleet agent's bot, deliver the post to that agent with `dispatch send`.
 *
 * Spec item 3 (SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09).
 *
 * WHY THE SENDER RELAYS. Telegram does not reliably carry one bot's post to
 * another bot (measured: Vera receives Maya's posts, Maya receives none of
 * Vera's). So the bot that posts is the one that relays, and nothing here
 * depends on bot-to-bot delivery in either direction.
 *
 * NOT NEW AUTHORITY. A relay is an addressing syntax for `dispatch send` and
 * carries exactly the direction rule a `dispatch send` carries today. Monty's
 * own tags are never relayed: he is human, and Telegram already delivers his
 * post to every bot in the group. Only outbound posts reach this code.
 *
 * ROSTER. SPEC-bridge-names-invite-excuse-2026-11-09 item 1: the relay's
 * allowlist is the standing roster ($FLEET_HANDOFF_AGENTS, from
 * agent-homes.env), not whatever `dispatch resolve` accepts, and a bare
 * `@<name>` of a roster agent is a tag too. If the roster cannot be read,
 * nothing relays and each tag is recorded skipped:"no-roster".
 *
 * IDENTITY. `dispatch send --from <Agent>` proves the sender by ancestry: the
 * agent's lock pid must be an ancestor of the dispatch process. The bridge is
 * a child of the agent's session, so a dispatch it spawns passes. If it ever
 * does not, dispatch exits 7 and that is recorded and reported, never routed
 * around.
 */

import { spawn } from 'child_process'

export const RELAY_MAX_PER_HOUR = 6
const HOUR_MS = 60 * 60 * 1000
const RESOLVE_TIMEOUT_MS = 10_000
const SEND_TIMEOUT_MS = 20_000

/** rc of the process; 124 when it was killed at the timeout, 127 when it could not start. */
export type Runner = (argv: string[], stdin: string | undefined, timeoutMs: number) => Promise<{ rc: number; stderr: string }>

export type RelayOutcome = { to: string; rc?: number; skipped?: 'rate' | 'roster' | 'no-roster' | 'sender-unverified' }

type Entity = { type: string; offset: number; length: number }

export type RelayPost = { message_id: number; text: string; entities?: Entity[] }

/** `MK_<Name>Bot` -> `<Name>`. Anything else is not a fleet agent's bot. */
export function botAgent(username: string): string | undefined {
  const m = /^MK_([A-Za-z][A-Za-z0-9]*)Bot$/i.exec(username)
  if (!m) return undefined
  return m[1][0].toUpperCase() + m[1].slice(1)
}

/**
 * Usernames tagged in one sent message, without the @. Telegram's own mention
 * entities when the sent message carries any; otherwise @username tokens.
 */
export function tagsIn(text: string, entities?: Entity[]): string[] {
  const mentions = (entities ?? []).filter(e => e.type === 'mention')
  if (mentions.length > 0) {
    return mentions.map(e => text.slice(e.offset + 1, e.offset + e.length))
  }
  return [...text.matchAll(/(?<![A-Za-z0-9_@])@([A-Za-z][A-Za-z0-9_]{3,31})/g)].map(m => m[1])
}

/** `@<name>` tokens in one sent message, without the @: `@maya`, `hi @Maya,`; never `x@maya.com` or `@MK_MayaBot`. */
export function namesIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[^\w@])@([A-Za-z][A-Za-z0-9]*)(?![\w])/g)].map(m => m[1])
}

/**
 * The standing roster, read from $FLEET_HANDOFF_AGENTS (space-separated, as
 * agent-homes.env sets it and the claude() wrapper reads it). Undefined when
 * it is unset or holds no name: the caller relays nothing.
 */
export function readRoster(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const names = (env.FLEET_HANDOFF_AGENTS ?? '').split(/\s+/).filter(n => /^[A-Za-z][A-Za-z0-9]*$/.test(n))
  return names.length > 0 ? names : undefined
}

/** At most `max` relays per (sender, recipient) pair in any rolling hour. */
export class RelayLimiter {
  private sent = new Map<string, number[]>()
  constructor(private max = RELAY_MAX_PER_HOUR, private now: () => number = Date.now) {}

  take(sender: string, recipient: string): boolean {
    const key = `${sender}\u0000${recipient}`
    const cutoff = this.now() - HOUR_MS
    const recent = (this.sent.get(key) ?? []).filter(t => t > cutoff)
    if (recent.length >= this.max) {
      this.sent.set(key, recent)
      return false
    }
    recent.push(this.now())
    this.sent.set(key, recent)
    return true
  }
}

export type RelayRequest = {
  chat_id: string
  thread_id?: number
  posts: RelayPost[]
}

export type RelayDeps = {
  /** This bridge's agent, as the claude() wrapper verified it, or '<Agent>'. */
  sender: string
  ownBot: () => string
  title: (chat_id: string) => string | undefined
  run: Runner
  limiter: RelayLimiter
  /** The standing roster; undefined when it could not be read. */
  roster: () => string[] | undefined
  stderr?: (line: string) => void
  dispatch?: string
}

/**
 * Plan synchronously, deliver asynchronously. Returns undefined when the post
 * tags no other fleet agent, so the caller knows at once that there is nothing
 * to wait for; otherwise a promise of one outcome per recipient.
 */
export function relayTags(deps: RelayDeps, req: RelayRequest): Promise<RelayOutcome[]> | undefined {
  const own = deps.ownBot().toLowerCase()
  const roster = deps.roster()
  const inRoster = (name: string) => roster?.find(r => r.toLowerCase() === name.toLowerCase())
  const seen = new Set<string>()
  const targets: Array<{ agent: string; username: string; skip?: RelayOutcome['skipped'] }> = []
  const add = (agent: string, username: string, skip?: RelayOutcome['skipped']) => {
    if (agent.toLowerCase() === deps.sender.toLowerCase()) return
    if (seen.has(agent.toLowerCase())) return
    seen.add(agent.toLowerCase())
    targets.push({ agent, username, skip })
  }
  for (const p of req.posts) {
    for (const u of tagsIn(p.text, p.entities)) {
      if (own && u.toLowerCase() === own) continue
      const agent = botAgent(u)
      if (!agent) continue
      const member = inRoster(agent)
      if (!roster) add(agent, u, 'no-roster')
      else add(member ?? agent, u, member ? undefined : 'roster')
    }
    // A bare @<name> is a tag only of a roster agent; @monty, @page and the
    // rest are names, not addresses, and are passed over without a record.
    // With no roster there is no telling, so each is recorded as unchecked.
    for (const n of namesIn(p.text)) {
      const member = inRoster(n)
      if (!roster) add(n[0].toUpperCase() + n.slice(1), n, 'no-roster')
      else if (member) add(member, n)
    }
  }
  if (targets.length === 0) return undefined

  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  if (!roster) {
    stderr('telegram channel: tag relay skipped: the standing roster ($FLEET_HANDOFF_AGENTS) could not be read\n')
  }
  const dispatch = deps.dispatch ?? 'dispatch'
  const first = req.posts[0]
  const where = `${deps.title(req.chat_id) ?? req.chat_id}/${req.thread_id ?? 'General'}`
  const text = req.posts.map(p => p.text).join('')

  return Promise.all(targets.map(async ({ agent, username, skip }): Promise<RelayOutcome> => {
    if (skip) return { to: agent, skipped: skip }
    // The sender name is what dispatch will check against the lock. A name the
    // wrapper could not verify is not one to sign with.
    if (deps.sender === '<Agent>' || !deps.sender) {
      stderr(`telegram channel: tag relay to ${agent} not sent: this bridge's agent name is unverified\n`)
      return { to: agent, skipped: 'sender-unverified' }
    }
    // A name the roster rejects is not relayed, and nothing else is guessed.
    const resolved = await deps.run([dispatch, 'resolve', '--to', `agent:${agent}`], undefined, RESOLVE_TIMEOUT_MS)
    if (resolved.rc !== 0) return { to: agent, skipped: 'roster' }
    if (!deps.limiter.take(deps.sender, agent)) {
      stderr(`telegram channel: tag relay ${deps.sender} -> ${agent} skipped: over ${RELAY_MAX_PER_HOUR} relays in the last hour\n`)
      return { to: agent, skipped: 'rate' }
    }
    const body = [
      `${deps.sender} tagged @${username} in a Telegram group post.`,
      '',
      `- group: ${deps.title(req.chat_id) ?? '(title unknown)'}`,
      `- chat_id: ${req.chat_id}`,
      `- thread_id: ${req.thread_id ?? '(General, none)'}`,
      `- message_id: ${first.message_id}`,
      '',
      'To answer in the same thread, reply with that chat_id and message_thread_id.',
      '',
      '## Post',
      '',
      text,
      '',
    ].join('\n')
    const sent = await deps.run([
      dispatch, 'send',
      '--to', `agent:${agent}`,
      '--from', deps.sender,
      '--tier', '2',
      '--subject', `Telegram tag from ${deps.sender} in ${where}`,
      '--body', '-',
    ], body, SEND_TIMEOUT_MS)
    if (sent.rc !== 0) {
      const why = sent.rc === 7 ? 'dispatch refused the sender identity (exit 7)' : `exit ${sent.rc}`
      stderr(`telegram channel: tag relay ${deps.sender} -> ${agent} failed: ${why}: ${sent.stderr.trim().split('\n').pop() ?? ''}\n`)
    }
    return { to: agent, rc: sent.rc }
  }))
}

export const spawnRunner: Runner = (argv, stdin, timeoutMs) =>
  new Promise(resolve => {
    let stderr = ''
    let done = false
    const finish = (rc: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ rc, stderr }) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (e) {
      resolve({ rc: 127, stderr: String(e) })
      return
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(124) }, timeoutMs)
    child.stderr?.on('data', d => { if (stderr.length < 4096) stderr += String(d) })
    child.on('error', e => { stderr += String(e); finish(127) })
    child.on('close', code => finish(code ?? 1))
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin ?? '')
  })
