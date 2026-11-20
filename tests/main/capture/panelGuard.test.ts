import { describe, expect, it, vi } from 'vitest'
import { createPanelGuard } from '../../../src/main/capture/panelGuard'

function setup() {
  let fire: () => void = () => {}
  const cancel = vi.fn()
  const setTimer = vi.fn((fn: () => void) => { fire = fn; return cancel })
  const onFail = vi.fn()
  const sendStarted = vi.fn()
  const guard = createPanelGuard({ timeoutMs: 10_000, setTimer, onFail, sendStarted })
  return { guard, onFail, sendStarted, cancel, setTimer, fire: () => fire() }
}

describe('createPanelGuard', () => {
  it('gives the panel 10 s to become ready', () => {
    const s = setup()
    expect(s.setTimer).toHaveBeenCalledWith(expect.any(Function), 10_000)
    s.fire()
    expect(s.onFail).toHaveBeenCalledTimes(1)
  })

  it('stops waiting once the panel is ready', () => {
    const s = setup()
    s.guard.ready()
    expect(s.cancel).toHaveBeenCalledTimes(1)
    expect(s.onFail).not.toHaveBeenCalled()
  })

  it('fails once whatever reports it: a load, a preload, a crash or a close', () => {
    const s = setup()
    s.guard.ready()
    s.guard.fail()
    s.guard.fail()
    s.fire()
    expect(s.onFail).toHaveBeenCalledTimes(1)
  })

  it('fails before the panel is ready too, and cancels the wait', () => {
    const s = setup()
    s.guard.fail()
    expect(s.onFail).toHaveBeenCalledTimes(1)
    expect(s.cancel).toHaveBeenCalledTimes(1)
  })

  it('ignores everything once disposed: closing the panel ourselves is no failure', () => {
    const s = setup()
    s.guard.dispose()
    expect(s.cancel).toHaveBeenCalledTimes(1)
    s.guard.fail()
    s.fire()
    s.guard.ready()
    s.guard.started(1000)
    expect(s.onFail).not.toHaveBeenCalled()
    expect(s.sendStarted).not.toHaveBeenCalled()
  })

  it('sends the start time once the panel is ready, whichever comes first', () => {
    const a = setup()
    a.guard.started(1000)
    expect(a.sendStarted).not.toHaveBeenCalled()
    a.guard.ready()
    expect(a.sendStarted).toHaveBeenCalledWith(1000)

    const b = setup()
    b.guard.ready()
    b.guard.started(2000)
    b.guard.ready()
    expect(b.sendStarted).toHaveBeenCalledTimes(1)
    expect(b.sendStarted).toHaveBeenCalledWith(2000)
  })

  it('sends no start time to a failed panel', () => {
    const s = setup()
    s.guard.fail()
    s.guard.ready()
    s.guard.started(1000)
    expect(s.sendStarted).not.toHaveBeenCalled()
  })
})
