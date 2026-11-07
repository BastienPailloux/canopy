import { expect, test } from 'vitest'
import { hiddenWindow } from '../../src/main/hiddenWindow'

test('a test run asks for the window to stay hidden', () => {
  expect(hiddenWindow({ isPackaged: false, env: { CANOPY_HIDE_WINDOW: '1' } })).toBe(true)
})

test('the window shows when nothing asks otherwise, or when the request is turned off', () => {
  expect(hiddenWindow({ isPackaged: false, env: {} })).toBe(false)
  expect(hiddenWindow({ isPackaged: false, env: { CANOPY_HIDE_WINDOW: '0' } })).toBe(false)
  expect(hiddenWindow({ isPackaged: false, env: { CANOPY_HIDE_WINDOW: '' } })).toBe(false)
})

test('a packaged app always shows its window', () => {
  expect(hiddenWindow({ isPackaged: true, env: { CANOPY_HIDE_WINDOW: '1' } })).toBe(false)
})
