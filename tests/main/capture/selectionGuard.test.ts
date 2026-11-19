import { describe, expect, it, vi } from 'vitest'
import { createSelectionGuard } from '../../../src/main/capture/selectionGuard'

function setup() {
  let fire: () => void = () => {}
  const cancel = vi.fn()
  const setTimer = vi.fn((fn: () => void) => { fire = fn; return cancel })
  const onEnd = vi.fn()
  const end = createSelectionGuard<string>({ timeoutMs: 60_000, setTimer, onEnd })
  return { end, onEnd, cancel, setTimer, fire: () => fire() }
}

describe('createSelectionGuard', () => {
  it('arms the selection timeout', () => {
    const s = setup()
    expect(s.setTimer).toHaveBeenCalledWith(expect.any(Function), 60_000)
  })

  it('ends with the first value only and cancels the timer', () => {
    const s = setup()
    s.end('a')
    s.end(null)
    s.fire()
    expect(s.onEnd).toHaveBeenCalledTimes(1)
    expect(s.onEnd).toHaveBeenCalledWith('a')
    expect(s.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the selection when nothing ends it in time', () => {
    const s = setup()
    s.fire()
    s.end('late')
    expect(s.onEnd).toHaveBeenCalledTimes(1)
    expect(s.onEnd).toHaveBeenCalledWith(null)
  })
})
