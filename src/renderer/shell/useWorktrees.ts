import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OrphanedWorktree } from '../../shared/api'
import type { Worktree, WorktreeStats } from '../../shared/types'
import { dropDrafts } from '../code/drafts'
import { forgetWorktree } from '../sessions/sessionStore'
import { useApp } from '../store'
import { createOrdering, eachLimit, latestOnly, minInterval, poll, POLL_DEGRADED_MS, POLL_HEALTHY_MS } from './polling'
import { entryPaths, listDiffers } from './workspaceList'

/** Each stats read runs several gits. */
const STATS_CONCURRENCY = 8
/** Switching windows back and forth must not walk the folder each time. */
const FOCUS_SCAN_MIN_MS = 10_000

/** What the page still holds for a worktree that is gone. */
export function forget(path: string): void {
  forgetWorktree(path)
  dropDrafts(path)
}

export interface StatsEntry { stats?: WorktreeStats; error?: string }
export type Ports = Record<string, Record<string, number>>

const knownPaths = (): string[] => entryPaths(useApp.getState().workspace, useApp.getState().worktrees)
const isActive = (repo: string): boolean => useApp.getState().repo === repo
const pick = <T,>(all: Record<string, T>, paths: Set<string>): Record<string, T> => Object.fromEntries(Object.entries(all).filter(([p]) => paths.has(p)))

/**
 * The worktrees of the active repo, refreshed on file events, on window focus, and by a poll that is slow while the
 * watcher works. The workspace is scanned again on focus and by the slow poll, which also refresh the other repos:
 * only the active one is watched. A failing stats call keeps the last good stats and flags that worktree only.
 */
export function useWorktrees(repo: string, root: string): { entries: Record<string, StatsEntry>; ports: Ports; listError: string | null; sync: () => Promise<void> } {
  const setWorktrees = useApp((s) => s.setWorktrees)
  const setOrphans = useApp((s) => s.setOrphans)
  const paths = useApp((s) => entryPaths(s.workspace, s.worktrees).join('\0'))
  const [entries, setEntries] = useState<Record<string, StatsEntry>>({})
  const [ports, setPorts] = useState<Ports>({})
  const [listError, setListError] = useState<string | null>(null)
  const watched = useRef('')
  const order = useRef(createOrdering())
  const seen = useRef(new Set<string>())
  const [watchFailed, setWatchFailed] = useState(false)

  const readPorts = useCallback((path: string): void => {
    window.canopy.terminalPorts(path).then((p) => setPorts((prev) => ({ ...prev, [path]: p })), () => undefined)
  }, [])

  /** Stats of one worktree. An answer overtaken by a later one is dropped. */
  const readStats = useCallback(async (path: string): Promise<void> => {
    const apply = order.current.begin(path)
    let patch: StatsEntry
    try {
      patch = { stats: await window.canopy.worktreeStats(path) }
    } catch (e) {
      patch = { error: e instanceof Error ? e.message : String(e) }
    }
    if (!apply()) return
    setEntries((prev) => ({ ...prev, [path]: { stats: prev[path]?.stats, ...patch } }))
  }, [])

  const readAll = useCallback((list: string[]): Promise<void> => eachLimit(list, STATS_CONCURRENCY, (path) => {
    readPorts(path)
    return readStats(path)
  }), [readPorts, readStats])

  const rescan = useMemo(() => latestOnly(() => window.canopy.scanWorkspace(root), (w) => {
    if (useApp.getState().workspace?.root === w.root) useApp.getState().setWorkspace(w)
  }), [root])

  /** Every orphan of the folder, whatever the active repo. Returns the ones that ended: nothing runs there any more. */
  const readOrphans = useCallback(async (): Promise<OrphanedWorktree[]> => {
    const gone = await window.canopy.orphanedWorktrees(root).catch(() => null)
    if (!gone || useApp.getState().workspace?.root !== root) return []
    const ended = useApp.getState().orphans.filter((o) => !gone.some((g) => g.path === o.path))
    setOrphans(gone)
    return ended
  }, [root, setOrphans])

  /** One that came back in `listed` is a worktree again, with what it held. */
  const settle = useCallback((ended: OrphanedWorktree[], listed: string[] = knownPaths()): void => {
    const left = ended.filter((o) => !listed.includes(o.path))
    left.forEach((o) => forget(o.path))
    // The last thing running in a deleted repo: nothing holds the selection there now.
    if (left.length > 0) void rescan()
  }, [rescan])

  const readList = useCallback(async (): Promise<void> => {
    const forRepo = repo
    let list: Worktree[]
    try {
      list = await window.canopy.listWorktrees(forRepo)
    } catch (e) {
      if (isActive(forRepo)) setListError(e instanceof Error ? e.message : String(e))
      settle(await readOrphans())
      return
    }
    // After the list: the main process compares with it. Before the store: the selection may be one of them.
    const ended = await readOrphans()
    if (!isActive(forRepo)) {
      settle(ended)
      return
    }
    setListError(null)
    setWorktrees(list)
    settle(ended, list.map((w) => w.path))
    if (listDiffers(useApp.getState().workspace, forRepo, list)) void rescan()
    // The main process watches exactly these, and drops the ones that left the list.
    const key = `${forRepo}\0${list.map((w) => w.path).join('\0')}`
    if (watched.current !== key) {
      watched.current = key
      window.canopy.watchWorktrees(forRepo).catch(() => { watched.current = '' })
    }
    list.forEach((w) => readPorts(w.path))
    await Promise.all(list.map((w) => readStats(w.path)))
  }, [repo, setWorktrees, readOrphans, settle, readStats, readPorts, rescan])
  // The repo may change during a run: what runs next is for the active one.
  const latest = useRef(readList)
  latest.current = readList
  /** Resolves once the list was read after this call, a rerun included: what follows can rely on it. */
  const refresh = useMemo(() => latestOnly(() => latest.current(), () => undefined), [])

  /**
   * The list first: a repo deleted under a running session must be known as an orphan before the scan misses it. The
   * orphans again after the scan: only it can tell about the repos that are not active.
   */
  const sync = useMemo(() => latestOnly(async () => {
    await refresh()
    await rescan()
    settle(await readOrphans())
    const { workspace, worktrees } = useApp.getState()
    const live = new Set(worktrees.map((w) => w.path))
    await readAll(entryPaths(workspace, worktrees).filter((p) => !live.has(p)))
  }, () => undefined), [refresh, rescan, readOrphans, settle, readAll])

  // Files or commits changed in a worktree: its numbers are stale, and the list too if one came or went.
  useEffect(() => {
    const offChanged = window.canopy.on('code:changed', (payload) => {
      const path = (payload as { cwd?: string } | null)?.cwd
      const { repo: forRepo, worktrees: known } = useApp.getState()
      if (!path || !forRepo || !known.some((w) => w.path === path)) return
      void readStats(path)
      void window.canopy.listWorktrees(forRepo).then((list) => {
        if (!isActive(forRepo)) return
        const shape = (l: Worktree[]): string => l.map((w) => w.path).join('\0')
        if (shape(list) !== shape(useApp.getState().worktrees)) void refresh()
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

  // Another active repo: its list and its watchers.
  useEffect(() => {
    setListError(null)
    setWatchFailed(false)
    watched.current = ''
    void refresh()
  }, [repo, refresh])

  // The remembered base changed: every number counted against it is stale.
  const baseEpoch = useApp((s) => s.baseEpoch)
  const counted = useRef(baseEpoch)
  useEffect(() => {
    if (counted.current === baseEpoch) return
    counted.current = baseEpoch
    void readAll(useApp.getState().worktrees.map((w) => w.path))
  }, [baseEpoch, readAll])

  // Entries that just appeared have nothing to show yet; the ones that left have nothing to keep.
  useEffect(() => {
    const now = new Set(paths === '' ? [] : paths.split('\0'))
    const fresh = [...now].filter((p) => !seen.current.has(p))
    seen.current = now
    setEntries((prev) => pick(prev, now))
    setPorts((prev) => pick(prev, now))
    void readAll(fresh)
  }, [paths, readAll])

  useEffect(() => {
    const scanDue = minInterval(FOCUS_SCAN_MIN_MS)
    const onFocus = (): void => void (scanDue() ? sync() : refresh())
    window.addEventListener('focus', onFocus)
    const stop = poll(() => void sync(), POLL_HEALTHY_MS)
    return () => {
      stop()
      window.removeEventListener('focus', onFocus)
    }
  }, [sync, refresh])

  useEffect(() => (watchFailed ? poll(() => void refresh(), POLL_DEGRADED_MS) : undefined), [refresh, watchFailed])

  return { entries, ports, listError, sync }
}
