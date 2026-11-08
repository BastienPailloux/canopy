import type { TicketFields } from '../../shared/tickets'

type Changes = Partial<TicketFields>

export interface Saver {
  /** Merges `c` into the pending changes, key by key, and saves them after a pause of `delayMs` without change. */
  change(c: Changes): void
  /** Saves what is pending now, and resolves once every save asked so far has ended. */
  flush(): Promise<void>
  /** Keys changed and not yet written: waiting for the pause, or being saved. */
  pending(): Set<keyof TicketFields>
}

/**
 * Autosave of the ticket editor: one `save` per pause, one at a time and in order. A failed save reports to `onError`
 * and keeps its changes pending, under the keys not changed since, for the next save.
 */
export function createSaver(save: (changes: Changes) => Promise<void>, delayMs = 500, onError?: (e: unknown) => void): Saver {
  let waiting: Changes = {}
  let inFlight: Changes = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()

  const run = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null }
    chain = chain.then(async () => {
      const changes = waiting
      if (Object.keys(changes).length === 0) return
      waiting = {}
      inFlight = changes
      try {
        await save(changes)
      } catch (e) {
        waiting = { ...changes, ...waiting }
        onError?.(e)
      } finally {
        inFlight = {}
      }
    })
    return chain
  }

  return {
    change(c) {
      waiting = { ...waiting, ...c }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void run() }, delayMs)
    },
    flush: run,
    pending: () => new Set([...Object.keys(inFlight), ...Object.keys(waiting)] as (keyof TicketFields)[])
  }
}

/** The fields the editor changes; the others (id, dates, branch, worktree, base) always come from disk. */
export const EDITED_KEYS = ['title', 'description', 'status', 'priority', 'labels', 'subtasks'] as const

/** A newer version from disk over what the editor shows: `keep` (pending or focused) keeps the editor's value. */
export function mergeDisk<T extends TicketFields>(local: T, disk: T, keep: ReadonlySet<keyof TicketFields>): T {
  const out = { ...disk }
  for (const k of EDITED_KEYS) if (keep.has(k)) (out as TicketFields)[k] = local[k] as never
  return out
}

/**
 * True the first time a version of the ticket is seen. Versions are told apart by content, not by `updated`: clocks
 * and hand edits do not keep it increasing, and a read started before a save may answer after it.
 */
export function createVersionFilter(): (t: TicketFields & { updated: string }) => boolean {
  const seen = new Set<string>()
  return (t) => {
    const key = JSON.stringify([t.updated, ...EDITED_KEYS.map((k) => t[k]), t.branch, t.worktree, t.base])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}
