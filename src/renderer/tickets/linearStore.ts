import { create } from 'zustand'
import { changedIds, type LinearConnection, type LinearLink, type LinearListState, type PendingEdit } from '../../shared/linear'
import { useApp } from '../store'

interface LinearState {
  connection: LinearConnection
  list: LinearListState
  pending: PendingEdit[]
  links: Record<string, LinearLink>
}

export const EMPTY_LIST: LinearListState = { issues: [], fetchedAt: null, error: null, expired: false, departures: [], kept: [] }

export const useLinear = create<LinearState>(() => ({
  connection: { state: 'disconnected', missingTools: [] },
  list: EMPTY_LIST,
  pending: [],
  links: {}
}))

export const REFRESH_MS = 180_000
/** A focus within this long of the last good sync does not ask Linear again. */
export const FOCUS_FRESH_MS = 30_000

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Connected or expired, or something cached: the Linear parts of the screen show. */
export function linearActive(s: Pick<LinearState, 'connection' | 'list'>): boolean {
  return s.connection.state !== 'disconnected' || s.list.issues.length > 0
}

/** The repo `connectLinear` follows, and the refresh in flight for it: one at a time, a repo switch drops it. */
let followed: string | null = null
let inflight: { repo: string; promise: Promise<void> } | null = null

/**
 * Refreshes the followed repo's list. A call while one runs for the same repo reuses it; an answer that arrives after
 * a repo switch is ignored. A failure keeps the issues (mirrors main) and only reports the error.
 */
export function refreshLinear(): Promise<void> {
  const repo = followed
  if (!repo || useLinear.getState().connection.state === 'disconnected') return Promise.resolve()
  if (inflight && inflight.repo === repo) return inflight.promise
  let mine!: { repo: string; promise: Promise<void> }
  mine = {
    repo,
    promise: (async () => {
      try {
        const list = await window.canopy.linearRefresh(repo)
        if (inflight === mine) useLinear.setState({ list })
      } catch (e) {
        if (inflight === mine) useLinear.setState((s) => ({ list: { ...s.list, error: message(e) } }))
      } finally {
        if (inflight === mine) inflight = null
      }
    })()
  }
  inflight = mine
  return mine.promise
}

/** Reads the followed repo's links again (after a launch: the issue's new branch). */
export async function reloadLinearLinks(): Promise<void> {
  const repo = followed
  if (!repo) return
  const links = await window.canopy.linearLinks(repo).catch(() => null)
  if (links && followed === repo) useLinear.setState({ links })
}

/**
 * Keeps `useLinear` on the active repo: reads it on start and on a repo change, refreshes every 3 minutes while the
 * Tickets view is shown, on window focus (unless the last good sync is under 30 s old), and re-reads (never refreshes)
 * on `linear:changed`: everything for an event naming no issue, else the list and the queue, the links only when a
 * linked issue is named. Returns the stop function.
 */
export function connectLinear(): () => void {
  let current: string | null = null
  let seq = 0
  let timer: ReturnType<typeof setInterval> | null = null

  /** `ids`: the issues an event named; omitted: read everything, branch listing and links included. */
  const read = async (ids?: string[]): Promise<void> => {
    const repo = current
    const mine = ++seq
    const latest = (): boolean => current === repo && seq === mine
    const c = window.canopy
    const known = useLinear.getState().links
    // Listing every linked repo's branches costs git calls: only when the event may have changed a link.
    const withLinks = ids === undefined || ids.some((id) => id in known)
    const [connection, list, pending, links] = await Promise.all([
      c.linearConnection().catch(() => null),
      repo ? (ids === undefined ? c.linearList(repo) : c.linearList(repo, false)).catch(() => null) : Promise.resolve(null),
      c.linearPending().catch(() => null),
      repo && withLinks ? c.linearLinks(repo).catch(() => null) : Promise.resolve(null)
    ])
    if (!latest()) return
    useLinear.setState((s) => ({
      connection: connection ?? s.connection,
      list: list ?? s.list,
      pending: pending ?? s.pending,
      links: links ?? s.links
    }))
  }

  const refresh = refreshLinear

  const syncTimer = (): void => {
    const want = useApp.getState().view === 'tickets' && current !== null
    if (want && !timer) timer = setInterval(() => { void refresh() }, REFRESH_MS)
    if (!want && timer) { clearInterval(timer); timer = null }
  }

  const follow = (repo: string | null): void => {
    current = repo
    followed = repo
    inflight = null
    // Links belong to a repo: the old repo's must not show under the new one. The list and the edits are app-wide.
    useLinear.setState({ links: {} })
    syncTimer()
    void read().then(() => { if (current === repo && useApp.getState().view === 'tickets') return refresh() })
  }

  const onFocus = (): void => {
    if (useApp.getState().view !== 'tickets') return
    const at = useLinear.getState().list.fetchedAt
    if (at !== null && Date.now() - Date.parse(at) < FOCUS_FRESH_MS) return
    void refresh()
  }
  window.addEventListener('focus', onFocus)
  const off = window.canopy.on('linear:changed', (p) => { void read(changedIds(p)) })
  follow(useApp.getState().repo)
  const unsub = useApp.subscribe((s, prev) => {
    if (s.repo !== prev.repo) follow(s.repo)
    else if (s.view !== prev.view) {
      syncTimer()
      if (s.view === 'tickets') void refresh()
    }
  })
  return () => {
    off(); unsub(); window.removeEventListener('focus', onFocus)
    if (timer) clearInterval(timer)
    timer = null; current = null; followed = null; inflight = null; seq++
  }
}
