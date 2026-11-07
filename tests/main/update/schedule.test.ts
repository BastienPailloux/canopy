import { expect, test } from 'vitest'
import { createSchedule, FORCE_AFTER_MS, WARNING_MS } from '../../../src/main/update/schedule'

test('deadline is 24h after the first download', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0)
  expect(s.tick(1000)).toEqual({ phase: 'ready', version: '1.1.0', deadline: FORCE_AFTER_MS })
})
test('a newer download replaces the version, keeps the deadline', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0); s.downloaded('1.2.0', 5 * 3600_000)
  expect(s.tick(5 * 3600_000)).toEqual({ phase: 'ready', version: '1.2.0', deadline: FORCE_AFTER_MS })
})
test('warning 10 minutes before', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0)
  expect(s.tick(FORCE_AFTER_MS - WARNING_MS)).toEqual({ phase: 'warning', version: '1.1.0', restartAt: FORCE_AFTER_MS })
})
test('sleep past deadline gives a full 10 minutes from wake', () => {
  const s = createSchedule(); s.downloaded('1.1.0', 0)
  const wake = FORCE_AFTER_MS + 3 * 3600_000
  expect(s.tick(wake)).toEqual({ phase: 'warning', version: '1.1.0', restartAt: wake + WARNING_MS })
  expect(s.tick(wake + 60_000)).toMatchObject({ restartAt: wake + WARNING_MS })
})
test('nothing downloaded', () => { expect(createSchedule().tick(0)).toEqual({ phase: 'none' }) })
