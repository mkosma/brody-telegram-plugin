/**
 * The bridge re-reads its outbound rules without a restart.
 *
 * Design: agents/Grady/design/DESIGN-bridge-hot-reloads-outbound-rules-2026-11-27.
 *
 * WHAT WAS SO. The bridge is a stdio server inside each agent's session, so
 * its code loaded once, at launch. A change to the private-chat gate or to
 * the links waited for the 04:00 restarts.
 *
 * WHAT IS SO NOW. server.ts holds outbound.ts by reference, through fresh().
 * Before each tool call it compares the file's mtime and size with what it
 * last looked at. Unchanged costs that one stat. Changed, the file is imported
 * again under a new query string, which is what makes the runtime read it
 * again, and the new version must export every function in OUTBOUND_EXPORTS.
 *
 * A BAD DEPLOY CANNOT SILENCE THE BOTS. A version that does not import, or
 * lacks an export, is not taken: the last good version keeps sending, and one
 * P2 goes to Grady through fleet-andon, key bridge-reload:<host>. It is raised
 * once, not once per call, and resolved when a good version loads. Each
 * session reloads its own copy; nothing is shared between bots.
 *
 * WHAT STILL NEEDS A RESTART is in the README, "What a deploy changes without
 * a restart".
 */

import { spawn } from 'child_process'
import { statSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { FLEET_ANDON_BIN } from './alert-tap.ts'

export const OUTBOUND_PATH = join(import.meta.dir, 'outbound.ts')

/** Every function server.ts calls in outbound.ts. A version missing one is not loaded. */
export const OUTBOUND_EXPORTS = [
  'assertOutboundChat', 'exempt', 'refusePrivateChat', 'huddleLinksReader', 'runReply', 'runReact', 'runEditMessage',
] as const

export type Outbound = Pick<typeof import('./outbound.ts'), (typeof OUTBOUND_EXPORTS)[number]>

export const RELOAD_ALERT_OWNER = 'Grady'
export const reloadAlertKey = (host: string) => `bridge-reload:${host}`

export type LoaderDeps = {
  path?: string
  /** What the file is compared by: its mtime and size. Throws for a file that is not there. */
  stamp?: (path: string) => string
  /** Imports the file as it is on disk now; `n` makes each import a new one. */
  load?: (path: string, n: number) => Promise<unknown>
  /** Runs fleet-andon with these arguments. Never awaited, never fails a send. */
  andon?: (argv: string[]) => void
  host?: string
  /** Whose bridge this is, for the alert's text: "Vera's". */
  whose?: string
  stderr?: (s: string) => void
}

const fileStamp = (path: string): string => {
  const st = statSync(path)
  return `${st.mtimeMs}:${st.size}`
}

function spawnAndon(argv: string[]): void {
  try {
    const p = spawn(FLEET_ANDON_BIN, argv, { stdio: 'ignore', detached: true })
    p.on('error', err => process.stderr.write(`telegram channel: fleet-andon did not run: ${err}\n`))
    p.unref()
  } catch (err) {
    process.stderr.write(`telegram channel: fleet-andon did not run: ${err}\n`)
  }
}

export function outboundLoader(deps: LoaderDeps = {}) {
  const path = deps.path ?? OUTBOUND_PATH
  const stamp = deps.stamp ?? fileStamp
  const load = deps.load ?? ((p: string, n: number) => import(`${p}?reload=${n}`))
  const andon = deps.andon ?? spawnAndon
  const host = deps.host ?? hostname().split('.')[0]
  const stderr = deps.stderr ?? ((s: string) => { process.stderr.write(s) })
  const key = reloadAlertKey(host)

  let current: Outbound | undefined
  let seen: string | undefined   // the stamp last looked at, whether it loaded or not
  let imports = 0
  let raised = false
  let queue: Promise<unknown> = Promise.resolve()

  async function check(): Promise<Outbound | undefined> {
    let now: string
    try { now = stamp(path) } catch (err) { now = `unreadable: ${err}` }
    if (now !== seen) {
      seen = now
      try {
        const mod = await load(path, ++imports) as Record<string, unknown>
        const missing = OUTBOUND_EXPORTS.filter(name => typeof mod[name] !== 'function')
        if (missing.length > 0) throw new Error(`it does not export ${missing.join(', ')}`)
        current = mod as Outbound
        if (raised) {
          raised = false
          andon(['--key', key, '--resolve', '--owner', RELOAD_ALERT_OWNER])
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        stderr(`telegram channel: outbound.ts did not load, ${current ? 'the last good version keeps sending' : 'and no version has loaded yet'}: ${why}\n`)
        if (!raised) {
          raised = true
          andon([
            '--severity', 'P2', '--owner', RELOAD_ALERT_OWNER, '--key', key,
            '--title', `bridge: outbound.ts did not load on ${host}`,
            '--message', `${deps.whose ?? 'A'} bridge on ${host} could not load the outbound.ts now on disk and ${current ? 'is sending with the last version that loaded' : 'has no version to send with'}. ${why}`,
          ])
        }
      }
    }
    return current
  }

  return {
    /**
     * The outbound rules as they are on disk now, or the last good version when
     * what is on disk does not load. Undefined only when no version ever loaded.
     * One at a time, so a call that arrives during a reload gets its result.
     */
    fresh(): Promise<Outbound | undefined> {
      const next = queue.then(check)
      queue = next.catch(() => {})
      return next
    },
    /** The loaded version, with no look at the disk: for a path that is not a tool call. */
    current: (): Outbound | undefined => current,
    /** The loaded version, or the error a tool returns when no version ever loaded. */
    need(): Outbound {
      if (!current) throw new Error('the bridge has no outbound rules loaded: outbound.ts failed to load at launch and Grady has the alert. It is read again at the next call.')
      return current
    },
  }
}

export type OutboundLoader = ReturnType<typeof outboundLoader>
