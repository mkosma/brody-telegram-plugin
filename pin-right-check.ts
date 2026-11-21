#!/usr/bin/env bun
/**
 * pin-right-check.ts <Agent>: does this agent's bot hold the right to pin in
 * each group it serves?
 *
 * pin_message works in a group only from a bot that is an administrator with
 * can_pin_messages (pin.ts). This asks Telegram, once per group in the
 * agent's access.json, and prints one JSON line per group:
 *
 *   {"agent","bot","chat_id","status","holds"}
 *
 * holds is true, false, or null when Telegram would not say. It asks through
 * pinRight, the same code pin_message uses to explain a refused pin.
 *
 * It calls getMe and getChatMember and nothing else: it sends nothing, takes
 * no update, and does not disturb a running bridge's poll. THE TOKEN is read
 * from the agent's own channel env file, as server.ts and wake-check.ts read
 * it, and is never printed: nothing here writes it, an error is reported by
 * its class, and the output is only the fields above.
 *
 * Exit 0 when every group was answered, 1 when any could not be, 2 on usage.
 */

import { Api } from 'grammy'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseEnvFile } from './inbound-gate.ts'
import { isGroupChatId } from './post-log.ts'
import { pinRight, type PinApi } from './pin.ts'
import { describeError, readAccess, resolveStateDir } from './wake-check.ts'

export async function main(argv: string[], io = {
  out: (l: string) => { process.stdout.write(l) },
  err: (l: string) => { process.stderr.write(l) },
}): Promise<number> {
  const agent = argv[0]
  if (argv.length !== 1 || !/^[A-Za-z][A-Za-z0-9]*$/.test(agent ?? '')) {
    io.err('usage: pin-right-check.ts <Agent>\n')
    return 2
  }
  const fail = (what: string) => { io.err(`pin-right-check ${agent}: ${what}\n`); return 1 }
  const root = process.env.FLEET_CHANNEL_ROOT ?? join(homedir(), '.claude', 'channels')
  const stateDir = resolveStateDir(agent, root)
  if (!stateDir) return fail(`no telegram state dir for ${agent} under ${root}`)
  let token: string | undefined
  try {
    token = parseEnvFile(readFileSync(join(stateDir, '.env'), 'utf8')).TELEGRAM_BOT_TOKEN
  } catch (e) {
    return fail(`channel env file unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`)
  }
  if (!token) return fail('no TELEGRAM_BOT_TOKEN in the channel env file')
  const access = readAccess(join(stateDir, 'access.json'))
  if (access === 'corrupt') return fail('access.json unreadable')
  const groups = Object.keys(access.groups ?? {}).filter(isGroupChatId)
  if (groups.length === 0) return fail('no group in access.json')

  // PIN_RIGHT_CHECK_API_ROOT exists for the stub API in the tests and nothing else.
  const api = new Api(token, {
    ...(process.env.PIN_RIGHT_CHECK_API_ROOT ? { apiRoot: process.env.PIN_RIGHT_CHECK_API_ROOT } : {}),
    timeoutSeconds: 8,
  })
  let bot: string
  try {
    bot = (await api.getMe()).username
  } catch (e) {
    return fail(`getMe failed: ${describeError(e)}`)
  }
  let unknown = 0
  for (const chat_id of groups) {
    const right = await pinRight(api as unknown as PinApi, chat_id)
    if (!right) unknown++
    io.out(JSON.stringify({
      agent, bot, chat_id,
      status: right?.status ?? null,
      holds: right ? right.holds : null,
    }) + '\n')
  }
  return unknown === 0 ? 0 : 1
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    e => { process.stderr.write(`pin-right-check: ${describeError(e)}\n`); process.exit(1) },
  )
}
