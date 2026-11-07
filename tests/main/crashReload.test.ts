import { expect, test } from 'vitest'
import { createCrashReload } from '../../src/main/crashReload'

test('a crash reloads, a clean exit does not', () => {
  const shouldReload = createCrashReload(() => 0)
  expect(shouldReload('crashed')).toBe(true)
  expect(shouldReload('clean-exit')).toBe(false)
})

test('a page that keeps crashing stops being reloaded, until a minute passed', () => {
  let now = 0
  const shouldReload = createCrashReload(() => now)
  expect([1, 2, 3, 4].map(() => shouldReload('crashed'))).toEqual([true, true, true, false])
  now = 60_000
  expect(shouldReload('oom')).toBe(true)
})
