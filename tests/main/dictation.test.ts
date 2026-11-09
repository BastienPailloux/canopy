import { expect, test, vi } from 'vitest'
import { startDictation } from '../../src/main/dictation'

test('startDictation sends the native selector to the focused field', () => {
  const send = vi.fn()
  startDictation(send)
  expect(send).toHaveBeenCalledWith('startDictation:')
})
