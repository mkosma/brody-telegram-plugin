/**
 * Peer posts: a bridge whose agent is present in a topic delivers every other
 * fleet bot's post in that topic from the post log, not from Telegram.
 *
 * Spec: agents/Grady/design/SPEC-bridge-presence-by-invite-2026-11-19,
 * amendment C.
 *
 * WHY THE LOG. Telegram hands a bot another bot's post only with Bot-to-Bot
 * Communication Mode on, Group Privacy off and admin rights (measured
 * 2026-11-20: only MK_VeraBot received peers' posts). Monty ruled out
 * depending on that. The record read here is the `dir:"out"` line the posting
 * bridge wrote itself, so nothing depends on bot-to-bot delivery.
 *
 * ONE READER. The log is read by running `tail-fleet-posts --json`, which
 * already merges both hosts and refuses to print a merge that is missing one.
 * There is no second reader here: a host it cannot read is a round that
 * delivers nothing and leaves the cursor where it was.
 *
 * ONCE ONLY. A post is keyed (chat_id, message_id). The key is taken when the
 * log delivers it and when Telegram hands this bridge a bot's post, whichever
 * comes first, and the set is kept in the state dir so a restart does not
 * deliver a post a second time.
 *
 * PRESENT ONLY. Presence is the thread entry `requireMention:false`, by the
 * gate's own function. In an absent topic nothing is delivered from the log;
 * a peer's tag there still travels by the tag relay.
 *
 * LOOP BOUND. The tag relay's rule: at most RELAY_MAX_PER_HOUR deliveries per
 * hour per (sending bot, receiving bot) pair. Past it the post is logged as
 * skipped and one stderr line is written.
 */

import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { requireMentionFor, type GroupPolicy } from './group-gate.ts'
import { safeTee, type Tee } from './post-log.ts'
import { RELAY_MAX_PER_HOUR, type RelayLimiter } from './tag-relay.ts'
import type { OutputRunner } from './invite-excuse.ts'

/** Half the 10s the spec allows from a peer's post to its delivery; the other half is the read. */
export const PEER_POLL_MS = 5_000
/** tail-fleet-posts gives up on a host at 5s; past this the reader itself is killed. */
export const PEER_READ_TIMEOUT_MS = 8_000
/** Each read starts this far behind the last one, so two hosts' clocks need not agree to the second. */
export const PEER_OVERLAP_MS = 60_000
/** After a restart, or a host that could not be read, nothing older than this is delivered. */
export const PEER_LOOKBACK_MS = 10 * 60_000
/** A key is kept longer than any read can reach back. */
export const PEER_SEEN_KEEP_MS = 30 * 60_000
/** Room for every post in one read's reach; the runner's own default would cut a busy topic short. */
export const PEER_READ_MAX_CHARS = 4 * 1024 * 1024

export const TAIL_FLEET_POSTS_BIN = process.env.TAIL_FLEET_POSTS_BIN ?? join(homedir(), '.local', 'bin', 'tail-fleet-posts')

/** One line of `tail-fleet-posts --json`: a post log record. */
export type PeerRecord = {
  ts?: string
  dir?: string
  bot?: string
  chat_id?: string | number
  thread_id?: number | null
  message_id?: number | null
  reply_to?: number | null
  text?: string
  edit?: boolean
}

export function postKey(chat_id: string | number, message_id: number): string {
  return `${chat_id}:${message_id}`
}

type SeenFs = { readFileSync: typeof readFileSync; writeFileSync: typeof writeFileSync; renameSync: typeof renameSync }

/**
 * The posts this bridge has already been handed, and where the log was last
 * read to. Kept in a file so both survive a restart. With no file yet the
 * cursor is the moment of construction: a bridge delivers no history.
 */
export class SeenPosts {
  private seen = new Map<string, number>()
  cursor: number

  constructor(
    private file: string | undefined,
    private now: () => number = Date.now,
    private fs: SeenFs = { readFileSync, writeFileSync, renameSync },
    private stderr: (line: string) => void = l => { process.stderr.write(l) },
  ) {
    this.cursor = now()
    if (!file) return
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { cursor?: string; seen?: Record<string, number> }
      const cursor = Date.parse(state.cursor ?? '')
      if (Number.isFinite(cursor)) this.cursor = cursor
      for (const [k, t] of Object.entries(state.seen ?? {})) {
        if (typeof t === 'number') this.seen.set(k, t)
      }
    } catch (err) {
      // No file is a first start. Anything else is said, and starts fresh.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.stderr(`telegram channel: peer post state unreadable, starting fresh: ${err}\n`)
      }
    }
  }

  has(key: string): boolean {
    return this.seen.has(key)
  }

  /** True the first time a key is taken, false ever after. */
  take(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.set(key, this.now())
    this.save()
    return true
  }

  save(): void {
    const cutoff = this.now() - PEER_SEEN_KEEP_MS
    for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k)
    if (!this.file) return
    try {
      const tmp = `${this.file}.tmp`
      this.fs.writeFileSync(tmp, JSON.stringify({ cursor: new Date(this.cursor).toISOString(), seen: Object.fromEntries(this.seen) }) + '\n', { mode: 0o600 })
      this.fs.renameSync(tmp, this.file)
    } catch (err) {
      this.stderr(`telegram channel: peer post state not saved: ${err}\n`)
    }
  }
}

export type PeerEvent = {
  content: string
  meta: Record<string, string>
}

export type PeerDeps = {
  ownBot: () => string
  /** access.json's groups, as the gate reads them, re-read on every round. */
  groups: () => Record<string, GroupPolicy>
  seen: SeenPosts
  limiter: RelayLimiter
  notify: (event: PeerEvent) => void
  tee?: Tee
  run: OutputRunner
  now?: () => number
  stderr?: (line: string) => void
  bin?: string
}

export type PeerOutcome = { key: string; bot: string; delivered: boolean; skipped?: 'rate' }

/**
 * Deliver the peers' posts among `records`, each at most once. Returns one
 * outcome per post that was this bridge's to decide; a record that is not a
 * peer's post in a present topic, or was already seen, has none.
 */
export function deliverPeerPosts(deps: PeerDeps, records: PeerRecord[]): PeerOutcome[] {
  const own = deps.ownBot().toLowerCase()
  // Before polling starts the bridge does not know its own username, so it
  // cannot tell its own posts from a peer's. Deliver nothing rather than guess.
  if (!own) return []
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const now = deps.now ?? Date.now
  const groups = deps.groups()
  const out: PeerOutcome[] = []
  for (const r of records) {
    // The record written by the bot that posted. An edit is the same post.
    if (r.dir !== 'out' || r.edit) continue
    const bot = typeof r.bot === 'string' ? r.bot : ''
    if (!bot || r.chat_id == null || typeof r.message_id !== 'number') continue
    if (bot.toLowerCase() === own) continue
    const chat_id = String(r.chat_id)
    const thread_id = r.thread_id ?? undefined
    const policy = groups[chat_id]
    if (!policy || requireMentionFor(policy, thread_id, true)) continue
    const key = postKey(chat_id, r.message_id)
    if (!deps.seen.take(key)) continue
    const text = r.text ?? ''
    const delivered = deps.limiter.take(bot, deps.ownBot())
    safeTee(deps.tee, {
      ts: new Date(now()).toISOString(),
      dir: 'in',
      chat_id,
      thread_id: thread_id ?? null,
      message_id: r.message_id,
      reply_to: r.reply_to ?? null,
      from_user: bot,
      from_id: null,
      from_is_bot: true,
      text,
      delivered,
      via: 'post-log',
      ...(delivered ? {} : { skipped: 'rate' }),
    })
    if (!delivered) {
      stderr(`telegram channel: peer post ${bot} -> ${deps.ownBot()} skipped: over ${RELAY_MAX_PER_HOUR} deliveries in the last hour (${key})\n`)
      out.push({ key, bot, delivered: false, skipped: 'rate' })
      continue
    }
    deps.notify({
      content: text,
      meta: {
        chat_id,
        message_id: String(r.message_id),
        ...(thread_id != null ? { message_thread_id: String(thread_id) } : {}),
        user: bot,
        ts: r.ts ?? new Date(now()).toISOString(),
        via: 'post-log',
      },
    })
    out.push({ key, bot, delivered: true })
  }
  return out
}

/** The JSON lines of `tail-fleet-posts --json`; a line that is not a record is passed over. */
export function parsePeerRecords(stdout: string): PeerRecord[] {
  const records: PeerRecord[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && typeof r === 'object') records.push(r as PeerRecord)
    } catch {}
  }
  return records
}

let unreadable = false

/**
 * One round: read the log from just behind the cursor, deliver, move the
 * cursor. Returns undefined when the log could not be read: nothing was
 * delivered and the cursor did not move, so the next good read covers the gap
 * (up to PEER_LOOKBACK_MS). One stderr line per outage, not per round.
 */
export async function pollPeerPosts(deps: PeerDeps): Promise<PeerOutcome[] | undefined> {
  if (!deps.ownBot()) return []
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l) })
  const started = (deps.now ?? Date.now)()
  const since = Math.max(deps.seen.cursor, started - PEER_LOOKBACK_MS) - PEER_OVERLAP_MS
  const r = await deps.run([deps.bin ?? TAIL_FLEET_POSTS_BIN, '--json', '--since', new Date(since).toISOString()], PEER_READ_TIMEOUT_MS, PEER_READ_MAX_CHARS)
  if (r.rc !== 0) {
    if (!unreadable) {
      stderr(`telegram channel: post log unreadable, no peer posts delivered until it reads again: rc=${r.rc} ${r.stderr.trim().split('\n').pop() ?? ''}\n`)
    }
    unreadable = true
    return undefined
  }
  if (unreadable) stderr('telegram channel: post log reads again\n')
  unreadable = false
  const outcomes = deliverPeerPosts(deps, parsePeerRecords(r.stdout))
  deps.seen.cursor = started
  deps.seen.save()
  return outcomes
}
