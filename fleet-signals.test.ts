// Reply context, the shared reaction log and the admin-status record.
// Grady's brief of 2026-11-23, class 2 batch 2, item 2, as widened that day.
// Stubbed runner, API and file writer: nothing here runs monty-reactions,
// reaches Telegram or writes outside the test.
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { replyContext, REPLY_TEXT_MAX } from './reply-context.ts'
import { logMontyReaction, reactionLine, MONTY_REACTIONS_BIN, type ReactionLogSinkDeps } from './reaction-log.ts'
import { adminStatus, adminStatusFile, recordGroupAdmin, type GroupAdminDeps, type Member } from './group-admin.ts'

const MONTY = '6324582303'
const GROUP = '-1009'
const server = () => readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

// --- reply context ---------------------------------------------------------------

test('reply context: a reply carries the id, the text on one line and the author', () => {
  expect(replyContext({ message_thread_id: 38, reply_to_message: { message_id: 2201, text: 'Shipped it.\nSee the log', from: { username: 'MK_WernerBot' } } }))
    .toEqual({ reply_to: '2201', reply_to_text: 'Shipped it. See the log', reply_to_from: 'MK_WernerBot' })
})

test('reply context: a post that is not a reply carries nothing', () => {
  expect(replyContext({ message_thread_id: 38 })).toEqual({})
  expect(replyContext(undefined)).toEqual({})
  expect(replyContext({ reply_to_message: {} })).toEqual({})
})

test('reply context: an ordinary post in a forum topic is not a reply to the topic', () => {
  expect(replyContext({ message_thread_id: 38, reply_to_message: { message_id: 38, forum_topic_created: { name: 'FLEET' } } })).toEqual({})
  expect(replyContext({ message_thread_id: 38, reply_to_message: { message_id: 38 } })).toEqual({})
  expect(replyContext({ message_thread_id: 38, reply_to_message: { message_id: 40, text: 'a real reply inside the topic' } }).reply_to).toBe('40')
})

test('reply context: the text is cut at 300 characters and cannot close its attribute', () => {
  const long = replyContext({ reply_to_message: { message_id: 7, text: 'x'.repeat(REPLY_TEXT_MAX + 50) } })
  expect(long.reply_to_text!.length).toBe(REPLY_TEXT_MAX)
  const odd = replyContext({ reply_to_message: { message_id: 7, text: 'he said "go" <now>\u0007', from: { first_name: 'Monty "K"' } } })
  expect(odd.reply_to_text).toBe("he said 'go' _now_")
  expect(odd.reply_to_from).toBe("Monty 'K'")
})

test('reply context: a replied-to photo gives its caption, and one with no text gives the id alone', () => {
  expect(replyContext({ reply_to_message: { message_id: 9, caption: 'the chart', from: { first_name: 'Monty' } } }))
    .toEqual({ reply_to: '9', reply_to_text: 'the chart', reply_to_from: 'Monty' })
  expect(replyContext({ reply_to_message: { message_id: 9 } })).toEqual({ reply_to: '9' })
})

test('reply context: the server puts it in the meta of every inbound post, text and media alike', () => {
  const src = server()
  const start = src.indexOf("  const stamping = inboundContext(")
  const meta = src.slice(start, src.indexOf('failed to deliver inbound to Claude', start))
  expect(meta).toContain('        ...replyContext(ctx.message),\n')
  // One builder serves text and media: the attachment fields sit in the same meta.
  expect(meta.indexOf('...replyContext(ctx.message)')).toBeLessThan(meta.indexOf('attachment_kind: attachment.kind'))
  expect(src).toContain('the tag carries reply_to (that message\\\'s id), reply_to_text')
})

// --- the shared reaction log -------------------------------------------------------

function sinkHarness(opts: { rc?: number; allowFrom?: string[]; bot?: string; throws?: boolean } = {}) {
  const runs: Array<{ argv: string[]; stdin?: string }> = []
  const errs: string[] = []
  const deps: ReactionLogSinkDeps = {
    run: async (argv, stdin) => {
      runs.push({ argv, stdin })
      if (opts.throws) throw new Error('spawn failed')
      return { rc: opts.rc ?? 0, stdout: '', stderr: opts.rc ? 'CANONICAL STORE UNREACHABLE\n' : '' }
    },
    allowFrom: () => opts.allowFrom ?? [MONTY],
    bot: () => opts.bot ?? 'MK_GradyBot',
    agent: 'Grady',
    stderr: s => { errs.push(s) },
  }
  return { deps, runs, errs }
}
const EV = { chat_id: GROUP, message_id: 2201, emoji: '👍', action: 'added', user_id: MONTY, ts: '2026-11-23T19:00:00.000Z' }

test('reaction log: a reaction of his in a group is one line handed to monty-reactions --append', async () => {
  const h = sinkHarness()
  expect(await logMontyReaction(h.deps, EV)).toBe(true)
  expect(h.runs.length).toBe(1)
  expect(h.runs[0].argv).toEqual([MONTY_REACTIONS_BIN, '--append'])
  expect(h.runs[0].stdin!.endsWith('\n')).toBe(true)
  expect(JSON.parse(h.runs[0].stdin!)).toEqual({ ts: '2026-11-23T19:00:00.000Z', chat_id: GROUP, message_id: 2201, emoji: '👍',
    action: 'added', user_id: MONTY, bot: 'MK_GradyBot', agent: 'Grady' })
})

test('reaction log: every emoji in every topic, and a removal says removed', async () => {
  const h = sinkHarness()
  await logMontyReaction(h.deps, { ...EV, emoji: '🔥', action: 'removed', message_id: 9 })
  expect(JSON.parse(h.runs[0].stdin!)).toMatchObject({ emoji: '🔥', action: 'removed', message_id: 9 })
  expect(reactionLine({ bot: () => '', agent: '<Agent>' }, EV).bot).toBe(null)
})

test('reaction log: only a user in the bridge\'s own allowFrom, and only in a group', async () => {
  const other = sinkHarness()
  expect(await logMontyReaction(other.deps, { ...EV, user_id: '8864978552' })).toBe(false)
  const dm = sinkHarness()
  expect(await logMontyReaction(dm.deps, { ...EV, chat_id: MONTY })).toBe(false)
  expect(other.runs.concat(dm.runs)).toEqual([])
  const configured = sinkHarness({ allowFrom: ['42'] })
  expect(await logMontyReaction(configured.deps, { ...EV, user_id: '42' })).toBe(true)
})

test('reaction log: a failed append is said on stderr and never rejects', async () => {
  const refused = sinkHarness({ rc: 75 })
  expect(await logMontyReaction(refused.deps, EV)).toBe(false)
  expect(refused.errs.join('')).toContain('monty-reactions --append failed (rc=75): CANONICAL STORE UNREACHABLE')
  const broken = sinkHarness({ throws: true })
  expect(await logMontyReaction(broken.deps, EV)).toBe(false)
  expect(broken.errs.join('')).toContain('rc=127')
})

test('reaction log: the server hands over each allowlisted reaction without waiting, with Telegram\'s own time', () => {
  const src = server()
  const start = src.indexOf("bot.on('message_reaction'")
  const body = src.slice(start, src.indexOf("bot.on('message:text'"))
  const at = body.indexOf('void logMontyReaction(reactionSinkDeps, {')
  expect(at).toBeGreaterThan(-1)
  expect(body.indexOf('if (!access.allowFrom.includes(userId)) return')).toBeLessThan(at)
  expect(at).toBeLessThan(body.indexOf('mcp.notification({'))
  expect(body.slice(at, at + 260)).toContain('ts: new Date((reaction.date ?? 0) * 1000).toISOString(),')
  // Monty's id is the bridge's config, never a literal in the module.
  expect(/\b\d{9,}\b/.test(readFileSync(join(import.meta.dir, 'reaction-log.ts'), 'utf8'))).toBe(false)
  // The alert-tap log for the acknowledgement path is still written.
  expect(body).toContain('void logAlertReaction(reactionLogDeps, {')
})

// --- is this bot an administrator --------------------------------------------------

test('group admin: an administrator receives reactions, a member does not', () => {
  expect(adminStatus({ status: 'administrator', can_pin_messages: true })).toEqual({ status: 'administrator', is_admin: true,
    receives_reactions: true, can_pin_messages: true, can_delete_messages: false, can_manage_topics: false })
  expect(adminStatus({ status: 'member', can_pin_messages: true })).toEqual({ status: 'member', is_admin: false,
    receives_reactions: false, can_pin_messages: false, can_delete_messages: false, can_manage_topics: false })
  expect(adminStatus({ status: 'creator' }).can_manage_topics).toBe(true)
  expect(adminStatus({}).status).toBe('unknown')
})

function adminHarness(members: Record<string, Member | Error>, groups = Object.keys(members)) {
  const asked: Array<[string, number]> = []
  const written: Array<{ file: string; text: string }> = []
  const errs: string[] = []
  const deps: GroupAdminDeps = {
    getChatMember: async (chat, user) => {
      asked.push([chat, user])
      const m = members[chat]
      if (m instanceof Error) throw m
      return m
    },
    groups: () => groups,
    bot: 'MK_WernerBot', bot_id: 42, agent: 'Werner', dir: '/tmp/tee',
    stderr: s => { errs.push(s) },
    write: (file, text) => { written.push({ file, text }) },
    now: () => new Date('2026-11-23T20:00:00Z'),
  }
  return { deps, asked, written, errs }
}

test('group admin: at startup it asks about itself in each group and writes one line', async () => {
  const h = adminHarness({ [GROUP]: { status: 'member' }, '-1010': { status: 'administrator', can_pin_messages: true } })
  await recordGroupAdmin(h.deps)
  expect(h.asked).toEqual([[GROUP, 42], ['-1010', 42]])
  expect(h.written.length).toBe(1)
  expect(h.written[0].file).toBe(adminStatusFile('/tmp/tee', 'MK_WernerBot'))
  expect(h.written[0].file).toBe('/tmp/tee/MK_WernerBot.admin.json')
  expect(h.written[0].text.trim().split('\n').length).toBe(1)
  const rec = JSON.parse(h.written[0].text)
  expect(rec).toMatchObject({ ts: '2026-11-23T20:00:00.000Z', bot: 'MK_WernerBot', agent: 'Werner' })
  expect(rec.chats[GROUP]).toMatchObject({ status: 'member', is_admin: false, receives_reactions: false })
  expect(rec.chats['-1010']).toMatchObject({ status: 'administrator', is_admin: true, receives_reactions: true, can_pin_messages: true })
  expect(h.errs.join('')).toContain(`@MK_WernerBot in ${GROUP}: member (NOT an administrator: Telegram sends this bot no reactions from this chat)`)
  expect(h.errs.join('')).toContain('@MK_WernerBot in -1010: administrator\n')
})

test('group admin: a group it cannot ask about is recorded with the error, not left out', async () => {
  const h = adminHarness({ [GROUP]: new Error('Forbidden: bot was kicked') })
  const chats = await recordGroupAdmin(h.deps)
  expect(chats[GROUP]).toEqual({ error: 'Forbidden: bot was kicked' })
  expect(JSON.parse(h.written[0].text).chats[GROUP]).toEqual({ error: 'Forbidden: bot was kicked' })
  const none = adminHarness({})
  await recordGroupAdmin(none.deps)
  expect(JSON.parse(none.written[0].text).chats).toEqual({})
})

test('group admin: a status file that cannot be written is said, and nothing rejects', async () => {
  const h = adminHarness({ [GROUP]: { status: 'administrator' } })
  h.deps.write = () => { throw new Error('EROFS') }
  await recordGroupAdmin(h.deps)
  expect(h.errs.join('')).toContain('could not write the admin status file')
})

test('group admin: the server asks once polling has started, for its own groups, and changes no right', () => {
  const src = server()
  const start = src.indexOf('onStart: info => {')
  const block = src.slice(start, src.indexOf('void bot.api.setMyCommands(', start))
  expect(block).toContain('void recordGroupAdmin({')
  expect(block).toContain('groups: () => Object.keys(loadAccess().groups).filter(isGroupChatId),')
  expect(block).toContain('bot: info.username, bot_id: info.id, agent: ACCESS_AGENT, dir: TEE_DIR,')
  expect(/promoteChatMember|setChatAdministratorCustomTitle/.test(src + readFileSync(join(import.meta.dir, 'group-admin.ts'), 'utf8'))).toBe(false)
})
