import { useCallback, useEffect, useRef, useState } from 'react'
import type { Worktree, WorktreeStats } from '../../shared/types'
import { useApp, worktreeLabel } from '../store'
import { NewWorktreeDialog } from './NewWorktreeDialog'
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog'
import { STATUS_LABEL, useStatuses } from './useStatuses'
import type { WorktreeStatus } from '../../shared/types'

const REFRESH_MS = 10_000

interface StatsEntry { stats?: WorktreeStats; error?: string }

/**
 * Worktrees of `repo`, refreshed every 10 s and on window focus.
 * A failing stats call keeps the last good stats and flags that worktree only.
 */
function useWorktrees(repo: string): { entries: Record<string, StatsEntry>; listError: string | null; refresh: () => Promise<void> } {
  const setWorktrees = useApp((s) => s.setWorktrees)
  const [entries, setEntries] = useState<Record<string, StatsEntry>>({})
  const [listError, setListError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const rerun = useRef(false)
  const watched = useRef('')
  const current = useRef(repo)
  current.current = repo

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
      if (current.current !== forRepo) return
      setListError(null)
      setWorktrees(list)
      // The main process watches exactly these, and drops the ones that left the list.
      const key = `${forRepo}\0${list.map((w) => w.path).join('\0')}`
      if (watched.current !== key) {
        watched.current = key
        window.canopy.watchWorktrees(forRepo).catch(() => { watched.current = '' })
      }
      await Promise.all(
        list.map(async (w) => {
          let patch: StatsEntry
          try {
            patch = { stats: await window.canopy.worktreeStats(w.path) }
          } catch (e) {
            patch = { error: e instanceof Error ? e.message : String(e) }
          }
          if (current.current !== forRepo) return
          setEntries((prev) => ({ ...prev, [w.path]: { stats: prev[w.path]?.stats, ...patch } }))
        })
      )
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
  }, [repo, setWorktrees])

  // Files or commits changed in a worktree: only its numbers are stale.
  useEffect(() => window.canopy.on('code:changed', (payload) => {
    const path = (payload as { cwd?: string } | null)?.cwd
    if (!path || !useApp.getState().worktrees.some((w) => w.path === path)) return
    const forRepo = current.current
    window.canopy.worktreeStats(path).then(
      (stats) => {
        if (current.current === forRepo) setEntries((prev) => ({ ...prev, [path]: { stats } }))
      },
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e)
        if (current.current === forRepo) setEntries((prev) => ({ ...prev, [path]: { stats: prev[path]?.stats, error } }))
      }
    )
  }), [])

  useEffect(() => {
    setEntries({})
    setListError(null)
    watched.current = ''
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  return { entries, listError, refresh }
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

function Row(props: { w: Worktree; entry?: StatsEntry; status: WorktreeStatus; active: boolean; onPick: () => void; onRemove: () => void }): React.JSX.Element {
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

export function WorktreeList({ repo }: { repo: string }): React.JSX.Element {
  const worktrees = useApp((s) => s.worktrees)
  const active = useApp((s) => s.worktree)
  const setWorktree = useApp((s) => s.setWorktree)
  const { entries, listError, refresh } = useWorktrees(repo)
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
          <Row key={w.path} w={w} entry={entries[w.path]} status={statuses[w.path] ?? 'idle'} active={w.path === active}
            onPick={() => setWorktree(w.path)} onRemove={() => setRemoving(w)} />
        ))}
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
          onRemoved={() => { setRemoving(null); void refresh() }} />
      )}
    </>
  )
}
