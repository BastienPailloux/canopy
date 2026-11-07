/** Where the file watcher works, polling only catches what it cannot see. */
export const POLL_HEALTHY_MS = 60_000
/** The watcher failed: polling is all there is. */
export const POLL_DEGRADED_MS = 10_000

interface Attention { hidden: boolean; hasFocus: () => boolean }

/** Nobody is looking at a hidden or blurred window: a focus event refreshes it when someone is. */
export const isAttended = (doc: Attention): boolean => !doc.hidden && doc.hasFocus()

/** Calls `read` every `ms` while the window is attended. Returns the stop function. */
export function poll(read: () => void, ms: number, doc: Attention = document): () => void {
  const timer = setInterval(() => { if (isAttended(doc)) read() }, ms)
  return () => clearInterval(timer)
}

export function debounce(fn: () => void, ms: number): { call: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    call() {
      clearTimeout(timer)
      timer = setTimeout(fn, ms)
    },
    cancel() { clearTimeout(timer) }
  }
}

/**
 * Keeps answers in the order they were asked. `begin` when asking; what it returns says, on the answer,
 * whether to apply it: not if an answer to a later question was already applied.
 */
export function createOrdering(): { begin: (key: string) => () => boolean } {
  let asked = 0
  const applied = new Map<string, number>()
  return {
    begin(key) {
      const id = ++asked
      return () => {
        if ((applied.get(key) ?? 0) > id) return false
        applied.set(key, id)
        return true
      }
    }
  }
}
