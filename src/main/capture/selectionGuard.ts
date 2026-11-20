/**
 * The selection's single ending: the first of a drag, a cancel, a veil failure and the timeout wins.
 * The timeout keeps a veil that never loads from leaving Canopy hidden and the screen covered.
 */
export function createSelectionGuard<T>(o: {
  timeoutMs: number
  /** Returns the cancel. */
  setTimer: (fn: () => void, ms: number) => () => void
  onEnd: (v: T | null) => void
}): (v: T | null) => void {
  let done = false
  const end = (v: T | null): void => {
    if (done) return
    done = true
    cancel()
    o.onEnd(v)
  }
  const cancel = o.setTimer(() => { end(null) }, o.timeoutMs)
  return end
}
