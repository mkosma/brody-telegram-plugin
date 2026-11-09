import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { tapToast, TOAST_MAX } from './tap-toast.ts'

const kb = (buttons: Array<{ text: string; callback_data: string }>) => ({ inline_keyboard: [buttons] })

test('resolved, known agent, matching button names agent and label', () => {
  const markup = kb([{ text: 'Approve', callback_data: 'ok:1' }, { text: 'Reject', callback_data: 'no:1' }])
  expect(tapToast('resolved', 'Vera', 'ok:1', markup)).toBe('✓ Sent to Vera: Approve')
})

test('matching button found across rows', () => {
  const markup = { inline_keyboard: [[{ text: 'A', callback_data: 'a' }], [{ text: 'B', callback_data: 'b' }]] }
  expect(tapToast('resolved', 'Vera', 'b', markup)).toBe('✓ Sent to Vera: B')
})

test('resolved, no matching button drops the label and never shows callback data', () => {
  const out = tapToast('resolved', 'Vera', 'secret:data', kb([{ text: 'Other', callback_data: 'x' }]))
  expect(out).toBe('✓ Sent to Vera')
  expect(out).not.toContain('secret:data')
  expect(tapToast('resolved', 'Vera', 'secret:data', undefined)).toBe('✓ Sent to Vera')
})

test('rejected names the agent and says not delivered', () => {
  const out = tapToast('rejected', 'Vera', 'ok:1', kb([{ text: 'Approve', callback_data: 'ok:1' }]))
  expect(out).toContain('Vera')
  expect(out).toContain('Not delivered')
})

test('timeout says sending, not sent', () => {
  const out = tapToast('timeout', 'Vera', 'ok:1', kb([{ text: 'Approve', callback_data: 'ok:1' }]))
  expect(out.startsWith('… Sending to')).toBe(true)
  expect(out).toBe('… Sending to Vera: Approve')
})

test('unverified agent placeholder says this session, never a name', () => {
  for (const o of ['resolved', 'rejected', 'timeout'] as const) {
    const out = tapToast(o, '<Agent>', 'ok:1', kb([{ text: 'Approve', callback_data: 'ok:1' }]))
    expect(out).toContain('this session')
    expect(out).not.toContain('<Agent>')
  }
})

test('a 300-character label is cut to at most 200 characters ending in an ellipsis', () => {
  const label = 'x'.repeat(300)
  const out = tapToast('resolved', 'Vera', 'ok:1', kb([{ text: label, callback_data: 'ok:1' }]))
  expect(out.length).toBeLessThanOrEqual(TOAST_MAX)
  expect(out.endsWith('…')).toBe(true)
  expect(out.startsWith('✓ Sent to Vera: x')).toBe(true)
})

test('cutting a label never splits an emoji', () => {
  const label = '🎵'.repeat(150)
  const out = tapToast('resolved', 'Vera', 'ok:1', kb([{ text: label, callback_data: 'ok:1' }]))
  expect(out.length).toBeLessThanOrEqual(TOAST_MAX)
  expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
})

// Revert guard: the generic callback path must answer the tap with text.
// A bare answerCallbackQuery() there is the defect this change fixed.
test('generic callback path never answers a tap with no text', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const start = src.indexOf('// Feature 3: General inline keyboard callback')
  const end = src.indexOf("bot.on('message_reaction'", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const generic = src.slice(start, end)
  expect(generic).toContain('tapToast(')
  expect(generic).not.toMatch(/answerCallbackQuery\(\s*\)/)
})

// --- Spec item 1: the post log ---------------------------------------------
// SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09, acceptance 1 and 2.

import { mkdtempSync, existsSync, statSync as fsStat } from 'fs'
import { tmpdir } from 'os'
import * as realFs from 'fs'
import { runReply, runEditMessage } from './reply.ts'
import { makeTee, teeInbound, type TeeFs } from './post-log.ts'

const GROUP = '-1004286764447'
const DM = '8123456789'

function stubApi() {
  let next = 500
  const calls: Array<{ chat_id: string; text: string; other?: Record<string, unknown> }> = []
  return {
    calls,
    api: {
      async sendMessage(chat_id: string, text: string, other?: Record<string, unknown>) {
        calls.push({ chat_id, text, other })
        return { message_id: next++ }
      },
      async sendPhoto() { return { message_id: next++ } },
      async sendDocument() { return { message_id: next++ } },
    },
  }
}

function replyDeps(api: ReturnType<typeof stubApi>['api'], tee?: (e: Record<string, unknown>) => void) {
  return {
    api,
    loadAccess: () => ({ textChunkLimit: 10 }),
    assertAllowedChat: () => {},
    assertSendable: () => {},
    stopTyping: () => {},
    ...(tee ? { tee } : {}),
  }
}

const teeDir = () => join(mkdtempSync(join(tmpdir(), 'tee-test-')), 'telegram-tee')
const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

test('outbound log: a group reply writes one line per chunk with the sent message ids', async () => {
  const dir = teeDir()
  const { api } = stubApi()
  const tee = makeTee({ dir, bot: () => 'MK_TestBot' })
  const text = 'aaaaaaaaaabbbbbbbbbbccccc' // 25 chars at a 10-char limit: three chunks
  const res = await runReply(replyDeps(api, tee), { chat_id: GROUP, text, message_thread_id: 39, reply_to: '77' })
  expect(res.content[0].text).toBe('sent 3 parts (ids: 500, 501, 502)')
  const got = lines(join(dir, 'MK_TestBot.jsonl'))
  expect(got.map(l => l.message_id)).toEqual([500, 501, 502])
  expect(got.map(l => l.text)).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'ccccc'])
  for (const l of got) {
    expect(l.dir).toBe('out')
    expect(l.bot).toBe('MK_TestBot')
    expect(l.chat_id).toBe(GROUP)
    expect(l.thread_id).toBe(39)
    expect(l.edit).toBe(false)
    expect(typeof l.ts).toBe('string')
  }
  // replyToMode defaults to 'first': only the first chunk quotes.
  expect(got.map(l => l.reply_to)).toEqual([77, null, null])
  expect(fsStat(dir).mode & 0o777).toBe(0o700)
  expect(fsStat(join(dir, 'MK_TestBot.jsonl')).mode & 0o777).toBe(0o600)
})

test('outbound log: a DM reply writes nothing', async () => {
  const dir = teeDir()
  const { api } = stubApi()
  const res = await runReply(replyDeps(api, makeTee({ dir, bot: () => 'MK_TestBot' })), { chat_id: DM, text: 'hello' })
  expect(res.content[0].text).toBe('sent (id: 500)')
  expect(existsSync(join(dir, 'MK_TestBot.jsonl'))).toBe(false)
})

test('outbound log: when the log write throws, the send still succeeds with the same result', async () => {
  const baseline = await runReply(replyDeps(stubApi().api), { chat_id: GROUP, text: 'aaaaaaaaaabbb' })
  const brokenFs: TeeFs = { ...realFs, appendFileSync: () => { throw new Error('disk full') } } as TeeFs
  const errs: string[] = []
  const broken = makeTee({ dir: teeDir(), bot: () => 'MK_TestBot', fs: brokenFs, stderr: l => { errs.push(l) } })
  const { api, calls } = stubApi()
  const res = await runReply(replyDeps(api, broken), { chat_id: GROUP, text: 'aaaaaaaaaabbb' })
  expect(res).toEqual(baseline)
  expect(calls.length).toBe(2)
  expect(errs.length).toBe(2)
  expect(errs[0]).toContain('disk full')
  // And a tee that throws outright, rather than failing inside, is contained too.
  const res2 = await runReply(replyDeps(stubApi().api, () => { throw new Error('boom') }), { chat_id: GROUP, text: 'aaaaaaaaaabbb' })
  expect(res2).toEqual(baseline)
})

test('outbound log: chunks sent before a failure are still logged', async () => {
  const dir = teeDir()
  let n = 0
  const api = {
    ...stubApi().api,
    async sendMessage() { if (n++ === 1) throw new Error('429'); return { message_id: 900 + n } },
  }
  await expect(runReply(replyDeps(api, makeTee({ dir, bot: () => 'MK_TestBot' })), { chat_id: GROUP, text: 'aaaaaaaaaabbbbbbbbbb' }))
    .rejects.toThrow('reply failed after 1 of 2')
  expect(lines(join(dir, 'MK_TestBot.jsonl')).map(l => l.message_id)).toEqual([901])
})

test('outbound log: edit_message writes one line with edit:true', async () => {
  const dir = teeDir()
  const api = { async editMessageText() { return { message_id: 42, message_thread_id: 39 } } }
  await runEditMessage({ api, assertAllowedChat: () => {}, tee: makeTee({ dir, bot: () => 'MK_TestBot' }) },
    { chat_id: GROUP, message_id: '42', text: 'revised' })
  const got = lines(join(dir, 'MK_TestBot.jsonl'))
  expect(got.length).toBe(1)
  expect(got[0]).toMatchObject({ dir: 'out', message_id: 42, thread_id: 39, text: 'revised', edit: true })
})

test('outbound log: rotates to .1 at the size cap', async () => {
  const dir = teeDir()
  const tee = makeTee({ dir, bot: () => 'MK_TestBot', maxBytes: 50 })
  for (let i = 0; i < 3; i++) tee({ ts: 'x', dir: 'out', text: 'y'.repeat(40) })
  expect(existsSync(join(dir, 'MK_TestBot.jsonl.1'))).toBe(true)
  expect(lines(join(dir, 'MK_TestBot.jsonl')).length).toBe(1)
})

const groupChat = { id: Number(GROUP), type: 'supergroup' }
const monty = { id: 111, username: 'monty', is_bot: false }

test('inbound log: a group message the gate drops is logged with delivered:false', () => {
  const dir = teeDir()
  const tee = makeTee({ dir, bot: () => 'MK_TestBot' })
  const r = teeInbound(
    { message: { message_id: 7, message_thread_id: 39 }, chat: groupChat, from: monty, text: 'untagged', tee },
    () => ({ action: 'drop' as const }),
  )
  expect(r.action).toBe('drop')
  const got = lines(join(dir, 'MK_TestBot.jsonl'))
  expect(got.length).toBe(1)
  expect(got[0]).toMatchObject({
    dir: 'in', bot: 'MK_TestBot', chat_id: GROUP, thread_id: 39, message_id: 7,
    from_user: 'monty', from_id: '111', from_is_bot: false, text: 'untagged', delivered: false,
  })
})

test('inbound log: a delivered group message says delivered:true, and a DM writes nothing', () => {
  const dir = teeDir()
  const tee = makeTee({ dir, bot: () => 'MK_TestBot' })
  teeInbound({ message: { message_id: 8 }, chat: groupChat, from: monty, text: 'hi', tee }, () => ({ action: 'deliver' }))
  teeInbound({ message: { message_id: 9 }, chat: { id: 111, type: 'private' }, from: monty, text: 'dm', tee }, () => ({ action: 'deliver' }))
  const got = lines(join(dir, 'MK_TestBot.jsonl'))
  expect(got.map(l => [l.message_id, l.delivered, l.thread_id])).toEqual([[8, true, null]])
})

// --- Spec item 2: per-topic mention gate -----------------------------------
// Acceptance 3.

import { groupDecision, requireMentionFor, type GroupPolicy } from './group-gate.ts'

const BOT = 'MK_VeraBot'
const fleet: GroupPolicy = { requireMention: false, allowFrom: [], threads: { '39': { requireMention: true } } }
const post = (text: string, thread?: number) => {
  const at = text.indexOf('@')
  return {
    text,
    ...(thread != null ? { message_thread_id: thread } : {}),
    entities: at >= 0 ? [{ type: 'mention', offset: at, length: text.length - at }] : [],
  }
}

test('thread gate: group off, thread 39 on', () => {
  expect(groupDecision(fleet, '111', post('what is playing', 39), BOT)).toBe('drop')
  expect(groupDecision(fleet, '111', post('what is playing @MK_VeraBot', 39), BOT)).toBe('deliver')
  expect(groupDecision(fleet, '111', post('what is playing', 40), BOT)).toBe('deliver')
  expect(groupDecision(fleet, '111', post('what is playing'), BOT)).toBe('deliver')
})

test('thread gate: a reply to the bot in a gated thread still delivers', () => {
  const m = { text: 'yes', message_thread_id: 39, reply_to_message: { from: { username: BOT } } }
  expect(groupDecision(fleet, '111', m, BOT)).toBe('deliver')
})

test('thread gate: a thread entry can also lift a group-wide requirement', () => {
  const p: GroupPolicy = { requireMention: true, allowFrom: [], threads: { '40': { requireMention: false } } }
  expect(requireMentionFor(p, 40)).toBe(false)
  expect(requireMentionFor(p, 39)).toBe(true)
  expect(requireMentionFor(p, undefined)).toBe(true)
  // A thread entry with no requireMention falls through to the group.
  expect(requireMentionFor({ requireMention: false, allowFrom: [], threads: { '39': {} } }, 39)).toBe(false)
})

test('inbound log + thread gate: an untagged post in a gated thread is logged delivered:false', () => {
  const dir = teeDir()
  const tee = makeTee({ dir, bot: () => BOT })
  const m = { message_id: 12, ...post('untagged', 39) }
  const r = teeInbound({ message: m, chat: groupChat, from: monty, text: m.text, tee },
    () => ({ action: groupDecision(fleet, '111', m, BOT) }))
  expect(r.action).toBe('drop')
  expect(lines(join(dir, `${BOT}.jsonl`)).map(l => [l.message_id, l.thread_id, l.delivered])).toEqual([[12, 39, false]])
})
