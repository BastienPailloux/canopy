import { expect, test } from 'vitest'
import { wrapTab } from '../../src/renderer/shell/useModal'

test('Tab moves on by itself inside the dialog', () => {
  expect(wrapTab(['a', 'b', 'c'], 'a', false)).toBeNull()
  expect(wrapTab(['a', 'b', 'c'], 'c', true)).toBeNull()
})

test('Tab past the last control wraps to the first, Shift+Tab before the first to the last', () => {
  expect(wrapTab(['a', 'b', 'c'], 'c', false)).toBe('a')
  expect(wrapTab(['a', 'b', 'c'], 'a', true)).toBe('c')
})

test('focus outside the controls enters at the matching end', () => {
  expect(wrapTab(['a', 'b'], null, false)).toBe('a')
  expect(wrapTab(['a', 'b'], 'z', true)).toBe('b')
})

test('a single control keeps focus both ways', () => {
  expect(wrapTab(['a'], 'a', false)).toBe('a')
  expect(wrapTab(['a'], 'a', true)).toBe('a')
})

test('no control gives nothing to move to', () => {
  expect(wrapTab([], null, false)).toBeNull()
})
