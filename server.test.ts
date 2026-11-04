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
