import { MAX_DESCRIPTION, MAX_TITLE, type TicketFields } from '../../shared/tickets'

export interface Saver<F extends object = TicketFields> {
  /** Merges `c` into the pending changes, key by key, and saves them after a pause of `delayMs` without change. */
  change(c: Partial<F>): void
  /** Saves what is pending now. Resolves once every save asked so far has ended: true if nothing is left pending. */
  flush(): Promise<boolean>
  /** Keys changed and not yet written: waiting for the pause, or being saved. */
  pending(): Set<keyof F>
  /** Stops the timers: nothing is saved on its own any more. */
  dispose(): void
}

export interface SaverOptions {
  onError?: (e: unknown) => void
  /** The pending keys may have changed. */
  onPending?: () => void
  /** Pause before a failed save is tried again on its own. */
  retryMs?: number
}

/**
 * Autosave of the ticket editor: one `save` per pause, one at a time and in order. A failed save reports to `onError`
 * and keeps its changes pending, under the keys not changed since, then is tried again after `retryMs`.
 */
export function createSaver<F extends object = TicketFields>(save: (changes: Partial<F>) => Promise<void>, delayMs = 500, o: SaverOptions = {}): Saver<F> {
  type Changes = Partial<F>
  let waiting: Changes = {}
  let inFlight: Changes = {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let disposed = false
  const empty = (c: Changes): boolean => Object.keys(c).length === 0

  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = disposed ? null : setTimeout(() => { void run() }, ms)
  }

  const run = (): Promise<boolean> => {
    if (timer) { clearTimeout(timer); timer = null }
    chain = chain.then(async () => {
      const changes = waiting
      if (empty(changes)) return
      waiting = {}
      inFlight = changes
      o.onPending?.()
      try {
        await save(changes)
      } catch (e) {
        waiting = { ...changes, ...waiting }
        o.onError?.(e)
        if (!timer) arm(o.retryMs ?? 3000)
      } finally {
        inFlight = {}
        o.onPending?.()
      }
    })
    return chain.then(() => empty(waiting) && empty(inFlight))
  }

  return {
    change(c) {
      waiting = { ...waiting, ...c }
      arm(delayMs)
      o.onPending?.()
    },
    flush: run,
    pending: () => new Set([...Object.keys(inFlight), ...Object.keys(waiting)] as (keyof F)[]),
    dispose() {
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
    }
  }
}

/** The savers of the open editors, and those still writing after their editor closed. */
const open = new Set<Saver>()
const listeners = new Set<() => void>()

/** Something changed in the tracked savers' pending keys. */
export function notifySavers(): void {
  for (const l of listeners) l()
}

/** Counts `s` among the open savers until the returned function is called. */
export function trackSaver(s: Saver): () => void {
  open.add(s)
  notifySavers()
  return () => { open.delete(s); notifySavers() }
}

/** Tickets with changes not written yet: what quitting now would lose. */
export const unsavedTickets = (): number => [...open].filter((s) => s.pending().size > 0).length

export function onSaversChange(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/**
 * The editor of `s` closed: writes what it holds, then stops counting it. A failed write stays counted (quit asks) and is
 * tried again with a growing pause, up to `maxMs`, until it works. `closed` false after the write: the editor came back
 * (StrictMode remount) and keeps its saver as it was.
 */
export async function closeSaver<F extends object>(s: Saver<F>, closed: () => boolean, backoff = { firstMs: 3000, maxMs: 60_000 }): Promise<void> {
  let ok = await s.flush()
  if (!closed()) return
  // Its own retry stops: this loop takes over, with a pause that grows.
  s.dispose()
  let wait = backoff.firstMs
  while (!ok) {
    await new Promise((resolve) => setTimeout(resolve, wait))
    wait = Math.min(wait * 2, backoff.maxMs)
    ok = await s.flush()
  }
  open.delete(s as Saver)
  notifySavers()
}

/** Writes what every open editor holds; true if nothing is left pending. */
export async function flushSavers(): Promise<boolean> {
  return (await Promise.all([...open].map((s) => s.flush()))).every(Boolean)
}

/** What a draft is created with: what the editor shows, and nothing while its title is empty, erased included. */
export function draftToCreate(local: TicketFields): TicketFields | null {
  if (local.title.trim() === '') return null
  const { title, description, status, priority, labels, subtasks } = local
  return { title, description, status, priority, labels, subtasks }
}

/** A ticket from the quick dialog (⇧⌘T): the editor's defaults for all but the title and description. */
export function quickTicketFields(title: string, description: string): TicketFields | null {
  const t = title.trim()
  // The same limits the main process checks: past them it would refuse the ticket.
  if (t === '' || t.length > MAX_TITLE || description.length > MAX_DESCRIPTION) return null
  return { title: t, description, status: 'backlog', priority: 'none', labels: [], subtasks: [] }
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
