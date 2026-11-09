import { create } from 'zustand'
import type { DepsReport } from '../../shared/deps'
import { useApp } from '../store'

interface DepsState {
  /** The displayed repo (main root) the rest belongs to. */
  repo: string | null
  /** Null before its first check, or while loading. */
  report: DepsReport | null
  loaded: boolean
  /** The banner is due: a critical entry the user has not dismissed. */
  banner: boolean
  /** A « Revérifier » asked by the user is running. */
  checking: boolean
  /** Why the last read or recheck failed. */
  error: string | null
}

export const useDeps = create<DepsState>(() => ({ repo: null, report: null, loaded: false, banner: false, checking: false, error: null }))

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
let seq = 0

async function load(repo: string): Promise<void> {
  const mine = ++seq
  try {
    const [report, banner] = await Promise.all([window.canopy.depsReport(repo), window.canopy.depsBanner(repo)])
    // The displayed repo changed meanwhile: this answer belongs to another one.
    if (seq !== mine || useDeps.getState().repo !== repo) return
    useDeps.setState({ report, banner, loaded: true, error: null })
  } catch (e) {
    if (seq === mine && useDeps.getState().repo === repo) useDeps.setState({ loaded: true, error: message(e) })
  }
}

function follow(repo: string | null): void {
  if (repo === useDeps.getState().repo) return
  seq++
  useDeps.setState({ repo, report: null, loaded: false, banner: false, checking: false, error: null })
  if (repo) void load(repo)
}

/** Follows the displayed repo and its `deps:changed` events; returns the undo. */
export function connectDeps(): () => void {
  useDeps.setState({ repo: null })
  const off = window.canopy.on('deps:changed', (p) => {
    const repo = (p as { repo?: unknown } | null)?.repo
    const { repo: current, report } = useDeps.getState()
    if (current && (repo === current || repo === report?.repo)) void load(current)
  })
  follow(useApp.getState().repo)
  const unsub = useApp.subscribe((s, prev) => { if (s.repo !== prev.repo) follow(s.repo) })
  return () => { off(); unsub(); seq++; useDeps.setState({ repo: null, report: null, loaded: false, banner: false, checking: false }) }
}

/** Checks the displayed repo now; the result lands through `deps:changed` too, but is taken here at once. */
export async function recheckDeps(): Promise<void> {
  const repo = useDeps.getState().repo
  if (!repo) return
  useDeps.setState({ checking: true, error: null })
  try {
    const report = await window.canopy.depsRecheck(repo)
    if (useDeps.getState().repo === repo) useDeps.setState({ report, loaded: true })
  } catch (e) {
    if (useDeps.getState().repo === repo) useDeps.setState({ error: message(e) })
  } finally {
    if (useDeps.getState().repo === repo) useDeps.setState({ checking: false })
  }
}

/** Closes the banner of the displayed repo until a new critical dependency appears. */
export async function dismissDepsBanner(): Promise<void> {
  const repo = useDeps.getState().repo
  if (!repo) return
  useDeps.setState({ banner: false })
  await window.canopy.depsDismissBanner(repo).catch(() => undefined)
}
