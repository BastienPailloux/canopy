import { create } from 'zustand'
import type { PrActResult, PrAction, PrCheck, PrDetail, PrOptions, PrSummary } from '../../shared/pr'
import { useApp } from '../store'
import { isAttended } from '../shell/polling'
import { askClaudeInNewTab } from '../sessions/sessionStore'
import { errorText } from './mergeModel'
import { checkPrompt } from './prPrompts'

export type PrSubTab = 'conv' | 'commits' | 'checks' | 'files'

interface PrState {
  /** The worktree followed, and the branch it was on: a PR belongs to that pair. */
  cwd: string | null
  branch: string | null
  /** The branch's latest PR, whatever its state; null: no PR, the tab hides. */
  summary: PrSummary | null
  /** Read even while the tab is hidden: the header badge counts its open threads. */
  detail: PrDetail | null
  options: PrOptions | null
  error: string | null
  busy: PrAction['type'] | null
  subTab: PrSubTab
  /** Thread id → the session tab « Faire corriger par Claude » started for it. Kept across worktrees: ids are global. */
  claudeThreads: Record<string, string>
}

const EMPTY = { summary: null, detail: null, options: null, error: null, busy: null }

export const usePr = create<PrState>(() => ({ cwd: null, branch: null, ...EMPTY, subTab: 'conv', claudeThreads: {} }))

export const POLL_MS = 60_000
/** A check running or auto-merge on: the PR changes by itself, soon. */
export const POLL_FAST_MS = 15_000

export const pollDelay = (detail: PrDetail | null): number =>
  detail && (detail.autoMerge || detail.checks.some((c) => c.outcome === 'pending')) ? POLL_FAST_MS : POLL_MS


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
 * Finds the branch's PR and reads it. An answer for a pair no longer followed, or overtaken by a
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

/**
 * Starts a new Claude session on the followed worktree with `text` and shows it; `threadId`: the thread it handles.
 * False: no worktree followed, nothing started.
 */
export function sendToClaude(text: string, threadId?: string): boolean {
  const { cwd } = usePr.getState()
  if (!cwd) return false
  const tabId = askClaudeInNewTab(cwd, text)
  if (threadId) usePr.setState((s) => ({ claudeThreads: { ...s.claudeThreads, [threadId]: tabId } }))
  useApp.getState().setView('sessions')
  return true
}

/**
 * « Corriger avec Claude » on a failed check, from its row or the merge panel: its log (`log` when already read, else
 * fetched for an Actions job), or its detail and link when there is none. False: no worktree followed.
 */
export async function fixCheck(pr: PrDetail, check: PrCheck, log?: string): Promise<boolean> {
  const cwd = usePr.getState().cwd
  if (!cwd) return false
  const still = followed()
  const text = log ?? (check.run ? await window.canopy.prFailedLog(cwd, check.run.runId, check.run.jobId).catch(() => '') : '')
  // Another worktree followed meanwhile: the old PR's fix must not start there.
  if (!still()) return false
  return sendToClaude(checkPrompt(pr, check, text, pr.headOid.slice(0, 7)))
}

/** True while the worktree, branch and PR followed now still are: an async step checks it before acting on them. */
function followed(): () => boolean {
  const { cwd, branch, summary } = usePr.getState()
  return () => {
    const s = usePr.getState()
    return s.cwd === cwd && s.branch === branch && s.summary?.number === summary?.number
  }
}

/** « Relancer les échecs »: one rerun per workflow run, stopped as soon as another worktree or PR is followed. */
export async function rerunFailed(runIds: number[]): Promise<void> {
  const still = followed()
  for (const runId of runIds) {
    if (!still()) return
    await act({ type: 'rerun', runId, jobId: null })
  }
}

/**
 * The ref Code compares against for a PR into `base`: its remote-tracking branch on origin (what GitHub diffs
 * against), else the local one, else another remote's. Null: none of `branches`.
 */
export function prBaseRef(base: string, branches: string[]): string | null {
  const has = new Set(branches)
  if (has.has(`origin/${base}`)) return `origin/${base}`
  if (has.has(base)) return base
  return branches.find((b) => b.endsWith(`/${base}`) && b.indexOf('/') === b.length - base.length - 1) ?? null
}

/** « Ouvrir le diff complet dans Code »: compares the worktree against the PR's base, then opens its first file. */
export async function openPrDiff(pr: PrDetail): Promise<void> {
  const cwd = usePr.getState().cwd
  if (!cwd || pr.files.length === 0) return
  const still = followed()
  const branches = await window.canopy.codeBranches(cwd).catch(() => [])
  if (!still()) return
  // Base not found locally: Code keeps its own comparison.
  const ref = prBaseRef(pr.base, branches)
  if (ref !== null) useApp.getState().setBase(cwd, ref)
  useApp.getState().openInCode(cwd, pr.files[0].path, 'diff')
}

export const setSubTab = (subTab: PrSubTab): void => usePr.setState({ subTab })

/** The selected worktree and its branch, as the worktree list last read them. */
function selected(): { cwd: string | null; branch: string | null } {
  const s = useApp.getState()
  const w = s.worktrees.find((x) => x.path === s.worktree)
  return w ? { cwd: w.path, branch: w.branch } : { cwd: null, branch: null }
}

/**
 * Keeps `usePr` on the selected worktree's branch: reads it on entering the tab and on window focus, and polls it
 * (`pollDelay`) even while the tab is hidden, for the header badge. Returns the stop function.
 */
export function connectPr(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!usePr.getState().cwd) return
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
  const onFocus = (): void => { if (usePr.getState().cwd) void refresh() }
  window.addEventListener('focus', onFocus)
  sync()
  // A second connect on the same worktree (StrictMode) follows nothing new: the pace must start anyway.
  schedule()
  const unApp = useApp.subscribe((s, prev) => {
    if (s.worktree !== prev.worktree || s.worktrees !== prev.worktrees) sync()
    if (s.view !== prev.view && s.view === 'pr') void refresh()
  })
  // A faster pace as soon as a check starts or auto-merge goes on; a new worktree followed starts its own pace.
  const unPr = usePr.subscribe((s, prev) => { if (s.detail !== prev.detail || s.cwd !== prev.cwd) schedule() })
  return () => {
    unApp(); unPr(); window.removeEventListener('focus', onFocus)
    if (timer) clearTimeout(timer)
    timer = null
  }
}
