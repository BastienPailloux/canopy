import { expect, test } from 'vitest'
import { createEchoFilter } from '../../src/renderer/code/editorEcho'

test('a value the editor sent coming back, however late, is not a change', () => {
  const echo = createEchoFilter()
  echo.sent('a')
  echo.sent('ab')
  expect(echo.isEcho('a')).toBe(true)
  expect(echo.isEcho('ab')).toBe(true)
})

test('React may skip values: an echo also settles the ones before it', () => {
  const echo = createEchoFilter()
  echo.sent('a')
  echo.sent('ab')
  expect(echo.isEcho('ab')).toBe(true)
  expect(echo.isEcho('a')).toBe(false)
})

test('a value the editor never sent is a real change, and ends what was pending', () => {
  const echo = createEchoFilter()
  echo.sent('a')
  expect(echo.isEcho('from disk')).toBe(false)
  expect(echo.isEcho('a')).toBe(false)
})
