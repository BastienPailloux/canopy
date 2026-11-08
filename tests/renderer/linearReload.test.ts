import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorReload } from '../../src/renderer/tickets/linearReload'

describe('createEditorReload', () => {
  let reload: ReturnType<typeof vi.fn<() => void>>
  let pending: ReturnType<typeof vi.fn<() => void>>
  let knownAt: string | null
  let gate: ReturnType<typeof createEditorReload>

  beforeEach(() => {
    vi.useFakeTimers()
    reload = vi.fn<() => void>()
    pending = vi.fn<() => void>()
    knownAt = '2026-11-08T10:00:00.000Z'
    gate = createEditorReload({ id: 'CAN-1', reload, pending, knownAt: () => knownAt })
  })
  afterEach(() => { gate.stop(); vi.useRealTimers() })

  it('an event naming other issues reads nothing', async () => {
    gate.event({ ids: ['CAN-2'] })
    gate.event({ ids: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).not.toHaveBeenCalled()
    expect(pending).not.toHaveBeenCalled()
  })

  it('an event naming this issue reads its queue only (no Linear call), once per burst, after 300 ms', async () => {
    gate.event({ ids: ['CAN-1'] })
    gate.event({ ids: ['CAN-1', 'CAN-2'] })
    await vi.advanceTimersByTimeAsync(299)
    expect(pending).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(pending).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('an event naming no issue (connection) reads the issue again, once per burst', async () => {
    gate.event({})
    gate.event({ ids: ['CAN-1'] })
    gate.event(undefined)
    await vi.advanceTimersByTimeAsync(300)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending).not.toHaveBeenCalled()
  })

  it('a newer copy in the list (a colleague, a resend by main) reads the issue again', async () => {
    gate.listed('2026-11-08T10:05:00.000Z')
    await vi.advanceTimersByTimeAsync(300)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the copy of its own save answer, or an older one, reads nothing', async () => {
    gate.listed('2026-11-08T10:00:00.000Z')
    gate.listed('2026-11-08T09:00:00.000Z')
    gate.listed(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('nothing is read while the issue is not loaded yet, nor after stop', async () => {
    knownAt = null
    gate.listed('2026-11-08T10:05:00.000Z')
    knownAt = '2026-11-08T10:00:00.000Z'
    gate.event({})
    gate.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).not.toHaveBeenCalled()
  })
})
