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

/** Says yes at most once per `ms`, the first time included. */
export function minInterval(ms: number): () => boolean {
  let last = -Infinity
  return () => {
    const now = Date.now()
    if (now - last < ms) return false
    last = now
    return true
  }
}

/** Runs `fn` over `items`, at most `limit` at a time: a wide workspace must not start every git at once. */
export async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * One `read` at a time. Calls arriving during a read share a single rerun after it, and that read's answer alone is
 * applied: one started before a change must not undo it. A failed read applies nothing.
 */
export function latestOnly<T>(read: () => Promise<T>, apply: (value: T) => void): () => Promise<void> {
  let running = false
  let rerun: Promise<void> | undefined
  let begin: ((run: Promise<void>) => void) | undefined
  const start = async (): Promise<void> => {
    running = true
    try {
      const value = await read()
      if (!rerun) apply(value)
    } catch {
      // what the last read gave stays
    }
    running = false
    const go = begin
    rerun = undefined
    begin = undefined
    go?.(start())
  }
  return () => {
    if (!running) return start()
    rerun ??= new Promise<void>((resolve) => { begin = resolve })
    return rerun
  }
}
