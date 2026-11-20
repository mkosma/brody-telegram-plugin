/**
 * Inbound context stamp: an agent may name one command that the bridge runs
 * when it delivers a post of Monty's, and whose output rides on that post as
 * `ctx_*` attributes.
 *
 * Spec: agents/Grady/design/SPEC-bridge-inbound-context-stamp-2026-11-20.
 *
 * WHY. "This track", "now" and "how long" mean the state at the moment Monty
 * spoke. Nothing tied that state to his message, so an agent answered from
 * whatever note it had read last. The stamp is an input to the agent's
 * judgment and gates nothing.
 *
 * OPT-IN, PER AGENT. `TELEGRAM_INBOUND_CONTEXT_CMD` in the agent's `.mcp.json`
 * telegram `env`. Unset, the stamp is `{}` and nothing is run, so the event is
 * the one the bridge sent before this existed.
 *
 * NO SHELL, NO MESSAGE TEXT. The setting is split on whitespace into an argv
 * and spawned directly. The command is given `--ts <iso>` and nothing of what
 * was said.
 *
 * MONTY ONLY. The sender must be in the bridge's top-level `allowFrom` (the
 * same authority /invite uses) and must not be a bot. A peer bot's post is
 * never stamped, whichever way it arrives.
 *
 * THE BRIDGE SAYS "UNKNOWN", NOT THE COMMAND. A timeout, a nonzero exit, or
 * output with no usable line gives the one attribute `ctx="unknown"` and one
 * stderr line. The command is killed and abandoned at the bound: a failed
 * stamp never drops a post and never holds it past INBOUND_CONTEXT_TIMEOUT_MS.
 */

import type { OutputRunner } from './invite-excuse.ts'

/** The whole wait for the command. Past it the post goes out with ctx="unknown". */
export const INBOUND_CONTEXT_TIMEOUT_MS = 3_000
export const CTX_MAX_KEYS = 8
export const CTX_MAX_VALUE = 200
const CTX_KEY_RE = /^[a-z_]{1,32}$/

export const INBOUND_CONTEXT_CMD = process.env.TELEGRAM_INBOUND_CONTEXT_CMD

export type ContextStamp = Record<string, string>

export const CTX_UNKNOWN: ContextStamp = { ctx: 'unknown' }

/** A value that cannot close the attribute it sits in or open a tag: no quote, no angle bracket, no control character. */
function safeValue(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CTX_MAX_VALUE).replace(/"/g, "'").replace(/[<>]/g, '_')
}

/** `key=value` lines to `ctx_<key>` attributes. A line whose key is not [a-z_]{1,32} is skipped; the first CTX_MAX_KEYS keys are kept. */
export function parseContext(stdout: string): ContextStamp {
  const out: ContextStamp = {}
  let kept = 0
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq)
    if (!CTX_KEY_RE.test(key)) continue
    if (`ctx_${key}` in out) continue
    if (kept >= CTX_MAX_KEYS) break
    out[`ctx_${key}`] = safeValue(line.slice(eq + 1))
    kept++
  }
  return out
}

export type ContextDeps = {
  /** The setting, as given. Undefined or blank: no stamp. */
  cmd: string | undefined
  /** The bridge's top-level allowFrom. */
  allowFrom: () => string[]
  run: OutputRunner
  stderr?: (line: string) => void
  timeoutMs?: number
}

export type ContextPost = {
  from: { id: number; is_bot?: boolean } | undefined
  /** The post's own time, ISO. */
  ts: string
}

/** The attributes to add to one delivered post. Resolves within the bound, never rejects. */
export async function inboundContext(deps: ContextDeps, post: ContextPost): Promise<ContextStamp> {
  const argv = (deps.cmd ?? '').split(/\s+/).filter(Boolean)
  if (argv.length === 0) return {}
  if (!post.from || post.from.is_bot || !deps.allowFrom().includes(String(post.from.id))) return {}
  const stderr = deps.stderr ?? (line => { process.stderr.write(line) })
  const unknown = (why: string): ContextStamp => {
    stderr(`telegram channel: inbound context command ${why}; post delivered with ctx="unknown"\n`)
    return { ...CTX_UNKNOWN }
  }
  const bound = deps.timeoutMs ?? INBOUND_CONTEXT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  // The runner kills at the bound; the race is what keeps a runner that does
  // not come back from holding the post.
  const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), bound + 250) })
  const r = await Promise.race([deps.run([...argv, '--ts', post.ts], bound).catch(() => undefined), late])
  clearTimeout(timer)
  if (!r) return unknown('did not return')
  if (r.rc === 124) return unknown(`timed out at ${bound}ms`)
  if (r.rc !== 0) return unknown(`exited ${r.rc}`)
  const stamp = parseContext(r.stdout)
  if (Object.keys(stamp).length === 0) return unknown('printed no key=value line')
  return stamp
}
