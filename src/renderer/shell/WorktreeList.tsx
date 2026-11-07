import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrphanedWorktree } from '../../shared/api'
import type { Worktree, WorktreeStats } from '../../shared/types'
import { dropDrafts } from '../code/drafts'
import { forgetWorktree } from '../sessions/sessionStore'
import { useApp, worktreeLabel } from '../store'
import { NewWorktreeDialog } from './NewWorktreeDialog'
import { createOrdering, poll, POLL_DEGRADED_MS, POLL_HEALTHY_MS } from './polling'
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog'
import { STATUS_LABEL, useStatuses } from './useStatuses'
import type { WorktreeStatus } from '../../shared/types'

/** What the page still holds for a worktree that is gone. */
function forget(path: string): void {
  forgetWorktree(path)
  dropDrafts(path)
}

interface StatsEntry { stats?: WorktreeStats; error?: string }
type Ports = Record<string, Record<string, number>>

/**
 * Worktrees of `repo`, refreshed on file events, on window focus, and by a poll that is slow while the watcher works.
 * A failing stats call keeps the last good stats and flags that worktree only.
 */
function useWorktrees(repo: string): { entries: Record<string, StatsEntry>; ports: Ports; listError: string | null; refresh: () => Promise<void> } {
  const setWorktrees = useApp((s) => s.setWorktrees)
  const setOrphans = useApp((s) => s.setOrphans)
  const [entries, setEntries] = useState<Record<string, StatsEntry>>({})
  const [ports, setPorts] = useState<Ports>({})
  const [listError, setListError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const rerun = useRef(false)
  const watched = useRef('')
  const current = useRef(repo)
  current.current = repo
  const order = useRef(createOrdering())
  const [watchFailed, setWatchFailed] = useState(false)

  const readPorts = useCallback((path: string): void => {
    window.canopy.terminalPorts(path).then((p) => setPorts((prev) => ({ ...prev, [path]: p })), () => undefined)
  }, [])

  /** Stats of one worktree. An answer overtaken by a later one is dropped. */
  const readStats = useCallback(async (path: string, forRepo: string): Promise<void> => {
    const apply = order.current.begin(path)
    let patch: StatsEntry
    try {
      patch = { stats: await window.canopy.worktreeStats(path) }
    } catch (e) {
      patch = { error: e instanceof Error ? e.message : String(e) }
    }
    if (current.current !== forRepo || !apply()) return
    setEntries((prev) => ({ ...prev, [path]: { stats: prev[path]?.stats, ...patch } }))
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      rerun.current = true
      return
    }
    inFlight.current = true
    const forRepo = repo
    try {
      let list: Worktree[]
      try {
        list = await window.canopy.listWorktrees(forRepo)
      } catch (e) {
        if (current.current === forRepo) setListError(e instanceof Error ? e.message : String(e))
        return
      }
      // After the list: the main process compares with it. Before the store: the selection may be one of them.
      const gone = await window.canopy.orphanedWorktrees(forRepo).catch((): OrphanedWorktree[] => [])
      if (current.current !== forRepo) return
      setListError(null)
      const ended = useApp.getState().orphans.filter((o) => !gone.some((g) => g.path === o.path) && !list.some((w) => w.path === o.path))
      setOrphans(gone)
      setWorktrees(list)
      ended.forEach((o) => forget(o.path))
      // The main process watches exactly these, and drops the ones that left the list.
      const key = `${forRepo}\0${list.map((w) => w.path).join('\0')}`
      if (watched.current !== key) {
        watched.current = key
        window.canopy.watchWorktrees(forRepo).catch(() => { watched.current = '' })
      }
      list.forEach((w) => readPorts(w.path))
      await Promise.all(list.map((w) => readStats(w.path, forRepo)))
      if (current.current === forRepo) {
        const paths = new Set(list.map((w) => w.path))
        setEntries((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => paths.has(p))))
      }
    } finally {
      inFlight.current = false
      if (rerun.current) {
        rerun.current = false
        void refresh()
      }
    }
  }, [repo, setWorktrees, setOrphans, readStats, readPorts])

  // Files or commits changed in a worktree: its numbers are stale, and the list too if one came or went.
  useEffect(() => {
    const offChanged = window.canopy.on('code:changed', (payload) => {
      const path = (payload as { cwd?: string } | null)?.cwd
      const known = useApp.getState().worktrees
      if (!path || !known.some((w) => w.path === path)) return
      const forRepo = current.current
      void readStats(path, forRepo)
      void window.canopy.listWorktrees(forRepo).then((list) => {
        if (current.current !== forRepo) return
        const paths = (l: Worktree[]): string => l.map((w) => w.path).join('\0')
        if (paths(list) !== paths(useApp.getState().worktrees)) void refresh()
      }, () => undefined)
    })
    const offError = window.canopy.on('code:watchError', () => setWatchFailed(true))
    // An orphan lasts as long as what runs in it.
    const onEnded = (): void => { if (useApp.getState().orphans.length > 0) void refresh() }
    const offState = window.canopy.on('session:state', onEnded)
    const offExit = window.canopy.on('terminal:exit', onEnded)
    const offPorts = window.canopy.on('terminal:portsChanged', (p) => {
      const path = (p as { cwd?: string } | null)?.cwd
      if (path) readPorts(path)
    })
    return () => { offChanged(); offError(); offState(); offExit(); offPorts() }
  }, [readStats, readPorts, refresh])

  useEffect(() => {
    setEntries({})
    setListError(null)
    watched.current = ''
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => poll(() => void refresh(), watchFailed ? POLL_DEGRADED_MS : POLL_HEALTHY_MS), [refresh, watchFailed])

  return { entries, ports, listError, refresh }
}

const plusIcon = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const trashIcon = (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
)

function Row(props: { w: Worktree; entry?: StatsEntry; ports?: Record<string, number>; status: WorktreeStatus; active: boolean; onPick: () => void; onRemove: () => void }): React.JSX.Element {
  const { w, entry } = props
  const stats = entry?.stats
  return (
    <div className="wt-row">
      <button className="wt" aria-current={props.active} onClick={props.onPick} data-testid="worktree" data-path={w.path}>
        <span className="dot" data-status={props.status} aria-hidden="true" />
        <span className="col">
          <span className="name" title={worktreeLabel(w)}>{worktreeLabel(w)}</span>
          <span className="status" data-status={props.status} data-testid="worktree-status">{w.isMain && props.status === 'idle' ? 'Principal' : STATUS_LABEL[props.status]}</span>
          <span className="numbers">
            {stats && stats.added > 0 && <span className="add">+{stats.added}</span>}
            {stats && stats.deleted > 0 && <span className="del">−{stats.deleted}</span>}
            {stats && (
              <span className="ahead">{stats.ahead === 0 ? 'à jour' : `${stats.ahead} commit${stats.ahead > 1 ? 's' : ''}`}</span>
            )}
            {Object.entries(props.ports ?? {}).map(([service, port]) => (
              <span key={service} className="port mono" title={`${service} : localhost:${port}`} data-testid="worktree-port">:{port}</span>
            ))}
            {entry?.error !== undefined && (
              <span className="warn" title={entry.error} data-testid="worktree-error">
                {stats ? 'données périmées' : 'état illisible'}
              </span>
            )}
          </span>
        </span>
      </button>
      {!w.isMain && (
        <button className="wt-remove" aria-label={`Supprimer ${worktreeLabel(w)}`} onClick={props.onRemove}>
          {trashIcon}
        </button>
      )}
    </div>
  )
}

const count = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

function liveText(w: OrphanedWorktree): string {
  return [
    ...(w.sessions > 0 ? [count(w.sessions, 'session', 'sessions')] : []),
    ...(w.terminals > 0 ? [count(w.terminals, 'terminal', 'terminaux')] : [])
  ].join(', ')
}

/** Deleted from outside while something runs there: reachable until that ends, closed from its tabs. */
function Orphans(props: { active: string | null; onPick: (path: string) => void }): React.JSX.Element | null {
  const orphans = useApp((s) => s.orphans)
  if (orphans.length === 0) return null
  return (
    <>
      <p className="list-error" role="alert" data-testid="orphan-notice">
        {orphans.map((w) => `« ${worktreeLabel(w)} » a disparu du disque : ${liveText(w)} encore actif${w.sessions + w.terminals > 1 ? 's' : ''}.`).join(' ')}
      </p>
      {orphans.map((w) => (
        <div key={w.path} className="wt-row">
          <button className="wt" aria-current={w.path === props.active} onClick={() => props.onPick(w.path)} data-testid="worktree-orphan" data-path={w.path}>
            <span className="dot" data-status="waiting" aria-hidden="true" />
            <span className="col">
              <span className="name" title={w.path}>{worktreeLabel(w)}</span>
              <span className="status">Dossier disparu · {liveText(w)}</span>
            </span>
          </button>
        </div>
      ))}
    </>
  )
}

export function WorktreeList({ repo }: { repo: string }): React.JSX.Element {
  const worktrees = useApp((s) => s.worktrees)
  const active = useApp((s) => s.worktree)
  const setWorktree = useApp((s) => s.setWorktree)
  const { entries, ports, listError, refresh } = useWorktrees(repo)
  const statuses = useStatuses(repo)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<Worktree | null>(null)

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Worktrees · {worktrees.length}</span>
        <button className="icon-btn" aria-label="Nouveau worktree" onClick={() => setCreating(true)}>{plusIcon}</button>
      </div>
      {listError && <p className="list-error" role="alert">Liste indisponible : {listError}</p>}
      <div className="wt-list">
        {worktrees.map((w) => (
          <Row key={w.path} w={w} entry={entries[w.path]} ports={ports[w.path]} status={statuses[w.path] ?? 'idle'} active={w.path === active}
            onPick={() => setWorktree(w.path)} onRemove={() => setRemoving(w)} />
        ))}
        <Orphans active={active} onPick={setWorktree} />
      </div>
      {creating && (
        <NewWorktreeDialog repo={repo} onClose={() => setCreating(false)}
          onCreated={(path) => {
            setCreating(false)
            void refresh().then(() => setWorktree(path))
          }} />
      )}
      {removing && (
        <RemoveWorktreeDialog repo={repo} worktree={removing} onClose={() => setRemoving(null)}
          onRemoved={() => { forget(removing.path); setRemoving(null); void refresh() }} />
      )}
    </>
  )
}
