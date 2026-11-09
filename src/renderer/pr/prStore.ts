import { create } from 'zustand'
import type { PrActResult, PrAction, PrDetail, PrOptions, PrSummary } from '../../shared/pr'
import { useApp } from '../store'
import { isAttended } from '../shell/polling'

export type PrSubTab = 'conv' | 'commits' | 'checks' | 'files'

interface PrState {
  /** The worktree followed, and the branch it was on: a PR belongs to that pair. */
  cwd: string | null
  branch: string | null
  /** The branch's latest PR, whatever its state; null: no PR, the tab hides. */
  summary: PrSummary | null
  /** Read only while the tab shows. */
  detail: PrDetail | null
  options: PrOptions | null
  error: string | null
  busy: PrAction['type'] | null
  subTab: PrSubTab
}

const EMPTY = { summary: null, detail: null, options: null, error: null, busy: null }

export const usePr = create<PrState>(() => ({ cwd: null, branch: null, ...EMPTY, subTab: 'conv' }))

export const POLL_MS = 60_000
/** A check running or auto-merge on: the PR changes by itself, soon. */
export const POLL_FAST_MS = 15_000

export const pollDelay = (detail: PrDetail | null): number =>
  detail && (detail.autoMerge || detail.checks.some((c) => c.outcome === 'pending')) ? POLL_FAST_MS : POLL_MS

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

/** Counts the refreshes started: only the latest one's answer applies. */
let seq = 0

/** Follows the worktree at `cwd`, on `branch`: what the previous pair showed goes, then it reads again. */
export function followWorktree(cwd: string | null, branch: string | null): void {
  const s = usePr.getState()
  if (s.cwd === cwd && s.branch === branch) return
  usePr.setState({ cwd, branch, ...EMPTY, subTab: 'conv' })
  void refresh()
}

/**
 * Finds the branch's PR, and reads it when the tab shows. An answer for a pair no longer followed, or overtaken by a
 * later refresh, is dropped. A failure keeps what shows and reports the error.
 */
export async function refresh(): Promise<void> {
  const { cwd, branch } = usePr.getState()
  if (!cwd) {
    if (useApp.getState().view === 'pr') useApp.getState().setView('code')
    return
  }
  const mine = ++seq
  const live = (): boolean => seq === mine && usePr.getState().cwd === cwd && usePr.getState().branch === branch
  const c = window.canopy
  try {
    const summary = await c.prFind(cwd)
    if (!live()) return
    if (!summary) {
      usePr.setState({ summary: null, detail: null, options: null, error: null })
      // The tab goes with the PR: whoever was on it lands on the code.
      if (useApp.getState().view === 'pr') useApp.getState().setView('code')
      return
    }
    const prev = usePr.getState()
    const other = prev.summary?.number !== summary.number
    usePr.setState(other ? { summary, detail: null, options: null } : { summary })
    if (useApp.getState().view !== 'pr') return
    const [detail, options] = await Promise.all([
      c.prView(cwd, summary.number),
      // Labels and people change rarely: read once per PR, a failure leaves the pickers empty.
      usePr.getState().options ? Promise.resolve(null) : c.prOptions(cwd, summary.number).catch(() => null)
    ])
    if (!live()) return
    usePr.setState((s) => ({ detail, options: options ?? s.options, error: null }))
  } catch (e) {
    if (live()) usePr.setState({ error: errorText(e) })
  }
}

/** Sends `action` to GitHub for the PR shown, then reads it again. Null: it failed, `error` says why. */
export async function act(action: PrAction): Promise<PrActResult | null> {
  const { cwd, summary } = usePr.getState()
  if (!cwd || !summary) return null
  usePr.setState({ busy: action.type, error: null })
  try {
    const result = await window.canopy.prAct(cwd, summary.number, action)
    await refresh()
    return result
  } catch (e) {
    if (usePr.getState().cwd === cwd) usePr.setState({ error: errorText(e) })
    return null
  } finally {
    if (usePr.getState().cwd === cwd) usePr.setState({ busy: null })
  }
}

export const setSubTab = (subTab: PrSubTab): void => usePr.setState({ subTab })

/** The selected worktree and its branch, as the worktree list last read them. */
function selected(): { cwd: string | null; branch: string | null } {
  const s = useApp.getState()
  const w = s.worktrees.find((x) => x.path === s.worktree)
  return w ? { cwd: w.path, branch: w.branch } : { cwd: null, branch: null }
}

/**
 * Keeps `usePr` on the selected worktree's branch, reads it on window focus and, while the PR tab shows, polls it
 * (`pollDelay`). Returns the stop function.
 */
export function connectPr(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (useApp.getState().view !== 'pr') return
    timer = setTimeout(() => {
      timer = null
      void (isAttended(document) ? refresh() : Promise.resolve()).finally(schedule)
    }, pollDelay(usePr.getState().detail))
  }
  const sync = (): void => {
    const { cwd, branch } = selected()
    followWorktree(cwd, branch)
  }
  // Also off the tab: a PR opened meanwhile shows its tab.
  const onFocus = (): void => { void refresh() }
  window.addEventListener('focus', onFocus)
  sync()
  const unApp = useApp.subscribe((s, prev) => {
    if (s.worktree !== prev.worktree || s.worktrees !== prev.worktrees) sync()
    if (s.view !== prev.view) {
      if (s.view === 'pr') void refresh()
      schedule()
    }
  })
  // A faster pace as soon as a check starts or auto-merge goes on.
  const unPr = usePr.subscribe((s, prev) => { if (s.detail !== prev.detail) schedule() })
  return () => {
    unApp(); unPr(); window.removeEventListener('focus', onFocus)
    if (timer) clearTimeout(timer)
    timer = null
  }
}
