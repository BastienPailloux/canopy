import { expect, test } from 'vitest'
import { notesToShow } from '../../../src/main/update/whatsNew'
import type { ReleaseNotes } from '../../../src/shared/update'

const note = (version: string): ReleaseNotes => ({ version, date: '2026-01-01', features: [], fixes: [] })
const history = [note('1.2.0'), note('1.1.0'), note('1.0.0')]

test('fresh install shows nothing', () => {
  expect(notesToShow(history, '1.2.0', undefined)).toEqual([])
})
test('shows skipped versions newest first', () => {
  expect(notesToShow(history, '1.2.0', '1.0.0').map((n) => n.version)).toEqual(['1.2.0', '1.1.0'])
})
test('compares numerically: 1.10.0 > 1.9.0', () => {
  const h = [note('1.10.0'), note('1.9.0')]
  expect(notesToShow(h, '1.10.0', '1.9.0').map((n) => n.version)).toEqual(['1.10.0'])
})
test('same version shows nothing', () => {
  expect(notesToShow(history, '1.2.0', '1.2.0')).toEqual([])
})
