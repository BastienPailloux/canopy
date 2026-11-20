import { describe, expect, it, vi } from 'vitest'
import { dictateInto, FOCUS_SETTLE_MS } from '../../src/renderer/sessions/dictation'

const field = (text: string) => ({ value: text, focus: vi.fn(), setSelectionRange: vi.fn() })

describe('dictateInto', () => {
  it('starts at once when the field already holds the focus, caret at the end', async () => {
    const el = field('abc')
    const start = vi.fn(async () => undefined)
    const wait = vi.fn(async () => undefined)
    await dictateInto(el, () => el, start, wait)
    expect(el.setSelectionRange).toHaveBeenCalledWith(3, 3)
    expect(wait).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
  })

  // macOS learns of the new focused field late and drops a dictation started before it does.
  it('focuses the field and lets macOS catch up before starting', async () => {
    const el = field('ab')
    let active: unknown = null
    const order: string[] = []
    el.focus.mockImplementation(() => { active = el; order.push('focus') })
    const wait = vi.fn(async (ms: number) => { order.push(`wait ${ms}`) })
    const start = vi.fn(async () => { order.push('start') })
    await dictateInto(el, () => active, start, wait)
    expect(order).toEqual(['focus', `wait ${FOCUS_SETTLE_MS}`, 'start'])
    expect(el.setSelectionRange).toHaveBeenCalledWith(2, 2)
  })

  // The native call dictates into whatever field holds the focus: never another one, nor after the composer left.
  it('does not start when the field lost the focus during the wait', async () => {
    const el = field('')
    let active: unknown = null
    el.focus.mockImplementation(() => { active = el })
    const start = vi.fn(async () => undefined)
    await dictateInto(el, () => active, start, async () => { active = { other: true } })
    expect(start).not.toHaveBeenCalled()
  })

  it('swallows a failed start', async () => {
    const el = field('')
    await expect(dictateInto(el, () => el, async () => { throw new Error('no') }, async () => undefined)).resolves.toBeUndefined()
  })
})
