/**
 * Watches the recording panel. A panel that never gets ready, or fails or closes on its own, leaves the user
 * without a stop button: `onFail` then stops the recording, once. It also hands the panel the acknowledged start,
 * once both are known, so its clock matches the 2-minute timer.
 */
export function createPanelGuard(o: {
  timeoutMs: number
  /** Returns the cancel. */
  setTimer: (fn: () => void, ms: number) => () => void
  onFail: () => void
  sendStarted: (startedAt: number) => void
}): {
  /** The panel page has its listeners set. */
  ready(): void
  /** The first frame was read, epoch ms. */
  started(at: number): void
  /** A load, preload, crash, hang or close: the panel can no longer stop anything. */
  fail(): void
  /** We close the panel ourselves: nothing it reports afterwards matters. */
  dispose(): void
} {
  let done = false
  let isReady = false
  let startedAt: number | null = null
  let sent = false
  const send = (): void => {
    if (done || sent || !isReady || startedAt === null) return
    sent = true
    o.sendStarted(startedAt)
  }
  const fail = (): void => {
    if (done) return
    done = true
    cancel()
    o.onFail()
  }
  const cancel = o.setTimer(fail, o.timeoutMs)
  return {
    ready() {
      if (done || isReady) return
      isReady = true
      cancel()
      send()
    },
    started(at) {
      startedAt = at
      send()
    },
    fail,
    dispose() {
      if (done) return
      done = true
      cancel()
    }
  }
}
