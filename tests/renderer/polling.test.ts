import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createOrdering, debounce, isAttended, poll } from '../../src/renderer/shell/polling'

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
