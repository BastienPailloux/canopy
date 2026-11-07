import { expect, test } from 'vitest'
import { diffAbandoned } from '../../src/renderer/code/diffOutcome'

test('a finished diff is complete, with or without changes', () => {
  expect(diffAbandoned({ lineChanges: [], quitEarly: false })).toBe(false)
  expect(diffAbandoned({ lineChanges: [{}], quitEarly: false })).toBe(false)
})

test('Monaco giving up is an abandoned diff, even with changes to show', () => {
  expect(diffAbandoned({ lineChanges: [{}], quitEarly: true })).toBe(true)
})

test('no result at all is an abandoned diff', () => {
  expect(diffAbandoned({ lineChanges: null, quitEarly: false })).toBe(true)
})

test('a build of Monaco without the signal falls back on the changes', () => {
  expect(diffAbandoned({ lineChanges: [], quitEarly: undefined })).toBe(false)
})
