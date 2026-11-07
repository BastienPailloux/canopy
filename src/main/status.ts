import type { WorktreeStatus } from '../shared/types'
import { prState as readPrState, type PrState } from './git/pr'

export type Activity = 'waiting' | 'working' | 'idle'

/** What the sidebar shows for a worktree: a question to answer first, then work in progress, then an open PR. */
export function worktreeStatus(activity: Activity, pr: PrState): WorktreeStatus {
  if (activity === 'waiting') return 'waiting'
  if (activity === 'working') return 'working'
  return pr === 'open' ? 'pr_open' : 'idle'
}

export interface AttentionDeps {
  /** Paths of every worktree of the repo, wherever they live. */
  worktrees: (repoPath: string) => Promise<string[]>
  activity: (cwd: string) => Activity
}

/** Whether a session in any worktree of the repo waits for an answer, displayed or not. */
export async function repoNeedsAttention(repoPath: string, deps: AttentionDeps): Promise<boolean> {
  try {
    return (await deps.worktrees(repoPath)).some((path) => deps.activity(path) === 'waiting')
  } catch {
    return false
  }
}

const PR_TTL_MS = 60_000
/** A focus refresh still does not hammer gh when the window is toggled quickly. */
const PR_FOCUS_MIN_MS = 5_000

interface PrEntry { state: PrState; at: number }

/** PR state per worktree: polled at most every 60 s, earlier only on focus. Concurrent reads share one gh call. */
export class PrCache {
  private readonly entries = new Map<string, PrEntry>()
  private readonly inFlight = new Map<string, Promise<PrState>>()

  constructor(private readonly read: (cwd: string) => Promise<PrState> = readPrState, private readonly now: () => number = Date.now) {}

  async get(cwd: string, onFocus = false): Promise<PrState> {
    const entry = this.entries.get(cwd)
    const age = entry ? this.now() - entry.at : Infinity
    if (entry && age < (onFocus ? PR_FOCUS_MIN_MS : PR_TTL_MS)) return entry.state
    const running = this.inFlight.get(cwd)
    if (running) return running
    const p = this.read(cwd).catch((): PrState => 'unavailable').then((state) => {
      this.entries.set(cwd, { state, at: this.now() })
      return state
    }).finally(() => { this.inFlight.delete(cwd) })
    this.inFlight.set(cwd, p)
    return p
  }
}
