// The huddle (huddle.ts): Grady's DESIGN-huddle-2026-11-26. Each test below
// has a revert in revert-proofs.py (ids HD*).

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { planHuddle, parseHuddleCommand, parseHuddleAnswer, runHuddleSection, runHuddleAnswer, chunkLines, unescapeMarkdown, messageLink, HUDDLE_BIN, HUDDLE_TIMEOUT_MS, HUDDLE_MAX_STDOUT, HUDDLE_ANSWER_RE, NOBODY_HERE, type HuddleDeps, type HuddleMessage } from './huddle.ts'
import { WHO_HEARS_BIN, WHO_TIMEOUT_MS, type OutputRunner } from './invite-excuse.ts'

const GROUP = '-1004286764447'
const DM = '8123456789'
const MONTY = 111
const THREAD = 40
const FLEET = ['Vera', 'Grady', 'Werner', 'Taiichi', 'Brody', 'Maya', 'Page']

type Post = { chat_id: string; text: string; thread_id?: number; markdown: boolean }

function rig(agent: string, results: Record<string, { rc: number; stdout: string; stderr?: string }> = {}, refuseMarkdown = false) {
  const calls: Array<{ argv: string[]; timeoutMs: number; maxStdout?: number }> = []
  const posts: Post[] = []
  const run: OutputRunner = async (argv, timeoutMs, maxStdout) => {
    calls.push({ argv, timeoutMs, ...(maxStdout != null ? { maxStdout } : {}) })
    const r = results[argv[0] === WHO_HEARS_BIN ? 'who' : 'huddle'] ?? { rc: 0, stdout: argv[0] === WHO_HEARS_BIN ? 'Vera, Grady\n' : '*Vera*\nnone\n' }
    return { rc: r.rc, stdout: r.stdout, stderr: r.stderr ?? '' }
  }
  const deps: HuddleDeps = {
    agent,
    run,
    post: async (chat_id, text, thread_id, markdown) => {
      if (markdown && refuseMarkdown) throw new Error("can't parse entities")
      posts.push({ chat_id, text, ...(thread_id != null ? { thread_id } : {}), markdown })
    },
    stderr: () => {},
  }
  const planDeps = { agent, loadAccess: () => ({ allowFrom: [String(MONTY)] }) }
  const msg = (text: string, over: Partial<HuddleMessage> = {}): HuddleMessage => ({ chat_id: GROUP, chat_type: 'supergroup', is_forum: true, from: { id: MONTY }, text, message_thread_id: THREAD, message_id: 3300, ...over })
  // The same composition server.ts uses: plan synchronously, then run.
  const send = async (text: string, over: Partial<HuddleMessage> = {}) => {
    const plan = planHuddle(planDeps, msg(text, over))
    if (plan.kind === 'section') await runHuddleSection(deps, plan)
    if (plan.kind === 'answer') await runHuddleAnswer(deps, plan)
    return plan.kind
  }
  return { deps, planDeps, msg, send, calls, posts }
}

test('huddle: each of the five commands from Monty makes the answerer run huddle once with the names, and every other bridge drops it', async () => {
  expect(HUDDLE_BIN.endsWith('/.local/bin/huddle')).toBe(true)
  for (const section of ['done', 'active', 'next', 'blockers', 'status']) {
    const kinds: Record<string, string> = {}
    const rigs = FLEET.map(agent => ({ agent, r: rig(agent) }))
    for (const { agent, r } of rigs) kinds[agent] = await r.send(`/${section} Vera, @grady`)
    expect(kinds).toEqual({ Vera: 'section', Grady: 'ignore', Werner: 'ignore', Taiichi: 'ignore', Brody: 'ignore', Maya: 'ignore', Page: 'ignore' })
    expect(rigs.flatMap(x => x.r.calls)).toEqual([{ argv: [HUDDLE_BIN, section, 'vera', 'grady'], timeoutMs: HUDDLE_TIMEOUT_MS, maxStdout: HUDDLE_MAX_STDOUT }])
    // One post, in the command's thread, as MarkdownV2.
    expect(rigs.flatMap(x => x.r.posts)).toEqual([{ chat_id: GROUP, text: '*Vera*\nnone', thread_id: THREAD, markdown: true }])
  }
  // Telegram's own form, any case, and the three words for everyone.
  expect(parseHuddleCommand('/Blockers@MK_VeraBot FLEET')).toEqual({ section: 'blockers', names: ['fleet'] })
  expect(parseHuddleCommand('/status everyone')).toEqual({ section: 'status', names: ['everyone'] })
  expect(parseHuddleCommand('/done all')).toEqual({ section: 'done', names: ['all'] })
  // Not a command mid-sentence, not a longer word, and not in a DM.
  const v = rig('Vera')
  expect(await v.send('what is /next')).toBe('none')
  expect(await v.send('/nextweek')).toBe('none')
  expect(await v.send('/blockers', { chat_id: DM, chat_type: 'private' })).toBe('none')
  expect(v.calls).toEqual([])
})

test('huddle: a command with no names asks who-hears for this topic, as /who does, and names those agents', async () => {
  const v = rig('Vera')
  expect(await v.send('/blockers')).toBe('section')
  expect(v.calls).toEqual([
    { argv: [WHO_HEARS_BIN, '40', '--chat', GROUP], timeoutMs: WHO_TIMEOUT_MS },
    { argv: [HUDDLE_BIN, 'blockers', 'Vera', 'Grady'], timeoutMs: HUDDLE_TIMEOUT_MS, maxStdout: HUDDLE_MAX_STDOUT },
  ])
  // General has the key "general"; a group that is not a forum passes --no-forum.
  const g = rig('Vera')
  await g.send('/status', { message_thread_id: undefined, is_forum: false })
  expect(g.calls[0].argv).toEqual([WHO_HEARS_BIN, 'general', '--chat', GROUP, '--no-forum'])
  // A topic nobody hears: one plain line, and huddle is not run.
  const n = rig('Vera', { who: { rc: 0, stdout: 'Nobody hears untagged posts here.\n' } })
  await n.send('/active')
  expect(n.calls.length).toBe(1)
  expect(n.posts).toEqual([{ chat_id: GROUP, text: NOBODY_HERE, thread_id: THREAD, markdown: false }])
})

test('huddle: a command from anyone but Monty runs nothing and is dropped', async () => {
  for (const from of [{ id: 222 }, { id: MONTY, is_bot: true }]) {
    for (const agent of FLEET) {
      const r = rig(agent)
      expect(await r.send('/blockers fleet', { from })).toBe('ignore')
      expect(r.calls).toEqual([])
      expect(r.posts).toEqual([])
    }
  }
})

test('huddle: a huddle that fails gets one plain failure line, and a refused MarkdownV2 post is sent again as plain text', async () => {
  const f = rig('Vera', { huddle: { rc: 2, stdout: '', stderr: 'huddle: not an agent: bob. The roster is Vera.\n' } })
  await f.send('/done bob')
  expect(f.posts).toEqual([{ chat_id: GROUP, text: '/done failed: huddle: not an agent: bob. The roster is Vera.', thread_id: THREAD, markdown: false }])
  const m = rig('Vera', { huddle: { rc: 0, stdout: '*Vera*\n[142](https://t.me/c/1/40/7) retire the old prompt\\. · since Nov 24 · no recommendation\n' } }, true)
  await m.send('/blockers vera')
  expect(m.posts).toEqual([{ chat_id: GROUP, text: 'Vera\n142 retire the old prompt. · since Nov 24 · no recommendation', thread_id: THREAD, markdown: false }])
  expect(unescapeMarkdown('_Done_\n• a\\-b \\(c\\)')).toBe('Done\n• a-b (c)')
})

test('huddle: a long answer is posted as whole lines in posts of at most 4096 characters', async () => {
  const lines = Array.from({ length: 120 }, (_, i) => `${i} ${'x'.repeat(98)}`)
  const chunks = chunkLines(lines.join('\n'))
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every(c => c.length <= 4096)).toBe(true)
  expect(chunks.join('\n').split('\n')).toEqual(lines)
  const v = rig('Vera', { huddle: { rc: 0, stdout: lines.join('\n') } })
  await v.send('/status fleet')
  expect(v.posts.length).toBe(chunks.length)
  expect(v.posts.every(p => p.markdown && p.thread_id === THREAD)).toBe(true)
})

test('huddle answer: each of the four forms from Monty runs huddle answer on the answerer alone, with his words, his message link and the agent', async () => {
  const cases: Array<[string, string[]]> = [
    ['142 yes Friday', ['142', 'yes', 'Friday']],
    ['142 no', ['142', 'no']],
    ['  142  Not Now Dec 3', ['142', 'not-now', 'Dec', '3']],
    ['142 TALK', ['142', 'talk']],
    ['3 no more than that', ['3', 'no', 'more', 'than', 'that']],
  ]
  for (const [text, words] of cases) {
    const kinds: Record<string, string> = {}
    const rigs = FLEET.map(agent => ({ agent, r: rig(agent, { huddle: { rc: 0, stdout: '142 = Vera: retire the old prompt, yes Friday\n' } }) }))
    for (const { agent, r } of rigs) kinds[agent] = await r.send(text)
    expect(kinds).toEqual({ Vera: 'answer', Grady: 'none', Werner: 'none', Taiichi: 'none', Brody: 'none', Maya: 'none', Page: 'none' })
    expect(rigs.flatMap(x => x.r.calls)).toEqual([{ argv: [HUDDLE_BIN, 'answer', ...words, '--link', 'https://t.me/c/4286764447/40/3300', '--as', 'Vera'], timeoutMs: HUDDLE_TIMEOUT_MS }])
    expect(rigs.flatMap(x => x.r.posts)).toEqual([{ chat_id: GROUP, text: '142 = Vera: retire the old prompt, yes Friday', thread_id: THREAD, markdown: false }])
  }
  expect(messageLink(GROUP, undefined, 9)).toBe('https://t.me/c/4286764447/9')
  expect(messageLink('-55', 40, 9)).toBeUndefined()
})

test('huddle answer: ordinary chat runs nothing, and neither does the same line from anyone but Monty', async () => {
  const v = rig('Vera')
  for (const text of ['yes', 'yes 142', '142', '142 maybe', '142 yesterday was fine', '142 nope', 'item 142 yes', '142: yes', '/who', 'I have 3 no wait 4 ideas', '142 talking now']) {
    expect(parseHuddleAnswer(text)).toBeUndefined()
    expect(await v.send(text)).toBe('none')
  }
  for (const from of [{ id: 222 }, { id: MONTY, is_bot: true }, undefined]) {
    expect(await v.send('142 yes Friday', { from })).toBe('none')
  }
  expect(await v.send('142 yes', { chat_id: DM, chat_type: 'private' })).toBe('none')
  expect(v.calls).toEqual([])
  expect(v.posts).toEqual([])
  expect(HUDDLE_ANSWER_RE.source).toBe('^\\s*(\\d+)\\s+(yes|no|not now|talk)\\b(.*)$')
})

test('huddle answer: what huddle refuses is posted as it said it, and a huddle that fails gets one failure line', async () => {
  const closed = rig('Vera', { huddle: { rc: 4, stdout: '142 is already closed (Vera: retire the old prompt). Nothing was recorded.\n' } })
  const plan = planHuddle(closed.planDeps, closed.msg('142 no'))
  expect(plan.kind === 'answer' && await runHuddleAnswer(closed.deps, plan)).toBe('refused')
  expect(closed.posts.map(p => p.text)).toEqual(['142 is already closed (Vera: retire the old prompt). Nothing was recorded.'])
  const dead = rig('Vera', { huddle: { rc: 75, stdout: '', stderr: 'huddle: CANONICAL STORE UNREACHABLE (maxi, from mini).\n' } })
  const plan2 = planHuddle(dead.planDeps, dead.msg('142 no'))
  expect(plan2.kind === 'answer' && await runHuddleAnswer(dead.deps, plan2)).toBe('failed')
  expect(dead.posts.map(p => p.text)).toEqual(['142 no failed: huddle: CANONICAL STORE UNREACHABLE (maxi, from mini).'])
})

test('huddle: the server plans it before the gate, drops a command, and lets an answer go on to the gate', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const start = src.indexOf('async function handleInbound(')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  const plan = body.indexOf('planHuddle(deps, { ...commandMessage, message_id: ctx.message?.message_id })')
  expect(plan).toBeGreaterThan(-1)
  expect(plan).toBeLessThan(body.indexOf('gate(ctx)'))
  const block = body.slice(plan, body.indexOf('gate(ctx)'))
  expect(block).toContain("if (huddle.kind === 'section' || huddle.kind === 'ignore') {\n    teeInbound(teeArgs, () => ({ action: 'drop' }))")
  expect(block).toContain("if (huddle.kind === 'section') void runHuddleSection(huddleDeps, huddle)\n    return\n  }")
  expect(block).toContain("  if (huddle.kind === 'answer') void runHuddleAnswer(huddleDeps, huddle)\n")
  expect(src).toContain("...(markdown ? { parse_mode: 'MarkdownV2' as const } : {}),")
})
