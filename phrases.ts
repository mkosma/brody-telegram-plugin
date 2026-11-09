/**
 * The bridge's answer to /invite and /excuse: one short line in the agent's
 * own voice, picked at random from the agent's own list.
 *
 * SPEC-bridge-names-invite-excuse-2026-11-09 item 2, as amended by Monty
 * (msg 390, agents 16d16c3). The list is
 * ~/dev/agents/agents/<Agent>/telegram-phrases.json, {"arrive": [...],
 * "depart": [...]}, written by each agent. It is read on each use, so an edit
 * takes effect without a restart. A phrase that is empty or longer than 12
 * words is skipped, and one bot never picks the same phrase twice in a row.
 * With no file, no readable file, or no valid phrase: "<Name> here." /
 * "<Name> out.", and one stderr line.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type PhraseKind = 'arrive' | 'depart'

export const PHRASE_MAX_WORDS = 12
export const PHRASES_ROOT = process.env.TELEGRAM_PHRASES_ROOT ?? join(homedir(), 'dev', 'agents', 'agents')

export function phrasesFile(agent: string, root = PHRASES_ROOT): string | undefined {
  if (!agent || !/^[A-Za-z][A-Za-z0-9]*$/.test(agent)) return undefined
  return join(root, agent, 'telegram-phrases.json')
}

export function validPhrases(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((p): p is string => typeof p === 'string')
    .map(p => p.trim())
    .filter(p => p.length > 0 && p.split(/\s+/).length <= PHRASE_MAX_WORDS)
}

export function fallbackPhrase(kind: PhraseKind, name: string): string {
  return kind === 'arrive' ? `${name} here.` : `${name} out.`
}

export class PhrasePicker {
  private last: string | undefined

  constructor(private opts: {
    /** The list's path; undefined when the agent name is unverified. */
    file: string | undefined
    /** The name in the fallback line. */
    name: () => string
    read?: (path: string) => string
    random?: () => number
    stderr?: (line: string) => void
  }) {}

  pick(kind: PhraseKind): string {
    const stderr = this.opts.stderr ?? ((l: string) => { process.stderr.write(l) })
    let valid: string[] = []
    let why = 'no phrase file for an unverified agent name'
    if (this.opts.file) {
      try {
        const parsed = JSON.parse((this.opts.read ?? (p => readFileSync(p, 'utf8')))(this.opts.file))
        valid = validPhrases(parsed?.[kind])
        why = `no valid "${kind}" phrase in ${this.opts.file}`
      } catch (err) {
        why = `cannot read ${this.opts.file}: ${err}`
      }
    }
    if (valid.length === 0) {
      stderr(`telegram channel: ${why}; answering with the fallback\n`)
      return fallbackPhrase(kind, this.opts.name())
    }
    // Never the same line twice in a row, unless it is the only valid one.
    const choices = valid.length > 1 ? valid.filter(p => p !== this.last) : valid
    const r = (this.opts.random ?? Math.random)()
    const pick = choices[Math.min(choices.length - 1, Math.floor(r * choices.length))]
    this.last = pick
    return pick
  }
}
