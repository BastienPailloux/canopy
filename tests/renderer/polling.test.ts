import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createOrdering, debounce, eachLimit, isAttended, latestOnly, poll } from '../../src/renderer/shell/polling'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const doc = (hidden: boolean, focused: boolean): { hidden: boolean; hasFocus: () => boolean } => ({ hidden, hasFocus: () => focused })

test('a window counts as attended only when shown and focused', () => {
  expect(isAttended(doc(false, true))).toBe(true)
  expect(isAttended(doc(true, true))).toBe(false)
  expect(isAttended(doc(false, false))).toBe(false)
})

test('poll skips its ticks while the window is not attended, and stops', () => {
  const state = { hidden: false, focused: false }
  const read = vi.fn()
  const stop = poll(read, 1000, { get hidden() { return state.hidden }, hasFocus: () => state.focused })
  vi.advanceTimersByTime(3000)
  expect(read).not.toHaveBeenCalled()
  state.focused = true
  vi.advanceTimersByTime(1000)
  expect(read).toHaveBeenCalledOnce()
  stop()
  vi.advanceTimersByTime(5000)
  expect(read).toHaveBeenCalledOnce()
})

test('debounce runs once after a burst, and cancel drops what is pending', () => {
  const fn = vi.fn()
  const d = debounce(fn, 300)
  d.call()
  vi.advanceTimersByTime(200)
  d.call()
  vi.advanceTimersByTime(299)
  expect(fn).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(fn).toHaveBeenCalledOnce()
  d.call()
  d.cancel()
  vi.advanceTimersByTime(1000)
  expect(fn).toHaveBeenCalledOnce()
})

test('an answer older than one already applied is dropped, per key', () => {
  const order = createOrdering()
  const older = order.begin('a')
  const newer = order.begin('a')
  const other = order.begin('b')
  expect(newer()).toBe(true)
  expect(older()).toBe(false)
  expect(other()).toBe(true)
})

test('answers arriving in order all apply', () => {
  const order = createOrdering()
  const first = order.begin('a')
  const second = order.begin('a')
  expect(first()).toBe(true)
  expect(second()).toBe(true)
})

test('eachLimit never runs more than the limit at once, and runs everything', async () => {
  vi.useRealTimers()
  let running = 0
  let peak = 0
  const seen: number[] = []
  await eachLimit([1, 2, 3, 4, 5], 2, async (n) => {
    peak = Math.max(peak, ++running)
    await Promise.resolve()
    seen.push(n)
    running--
  })
  expect(peak).toBe(2)
  expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
})

describe('latestOnly', () => {
  function deferredReads(): { read: () => Promise<string>; answer: (i: number, v: string) => void; count: () => number } {
    const pending: ((v: string) => void)[] = []
    return {
      read: () => new Promise<string>((resolve) => { pending.push(resolve) }),
      answer: (i, v) => pending[i](v),
      count: () => pending.length
    }
  }
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  test('applies the answer of a lone call', async () => {
    const r = deferredReads()
    const applied: string[] = []
    const done = latestOnly(r.read, (v) => applied.push(v))()
    r.answer(0, 'a')
    await done
    expect(applied).toEqual(['a'])
  })

  test('calls during a run share one rerun, and the overtaken answer is never applied', async () => {
    const r = deferredReads()
    const applied: string[] = []
    const run = latestOnly(r.read, (v) => applied.push(v))
    const first = run()
    const second = run()
    const third = run()
    expect(r.count()).toBe(1)
    r.answer(0, 'stale')
    await flush()
    expect(r.count()).toBe(2)
    r.answer(1, 'fresh')
    await Promise.all([first, second, third])
    expect(applied).toEqual(['fresh'])
  })

  test('a failed read applies nothing and does not block the next one', async () => {
    const applied: string[] = []
    let fail = true
    const run = latestOnly(async () => { if (fail) throw new Error('gone'); return 'ok' }, (v) => applied.push(v))
    await run()
    fail = false
    await run()
    expect(applied).toEqual(['ok'])
  })
})
