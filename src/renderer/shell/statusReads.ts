import type { Activity, Workspace, Worktree, WorktreeStatus } from '../../shared/types'
import { eachLimit } from './polling'

/** What a sidebar row needs to get a status. */
export interface StatusRow { path: string; repo: string; branch: string | null }

/** Each read crosses to the main process, and a repo's can cost a gh call. */
const READ_CONCURRENCY = 8

/** What the sidebar shows for a worktree: a question to answer first, then work in progress, then an open PR. */
export function worktreeStatus(activity: Activity, prOpen: boolean): WorktreeStatus {
  if (activity === 'waiting') return 'waiting'
  if (activity === 'working') return 'working'
  return prOpen ? 'pr_open' : 'idle'
}

/** The live list of the active repo first, then every other entry: the same rows as `entryPaths`. */
export function statusRows(w: Workspace | null, list: Worktree[], activeRepo: string | null): StatusRow[] {
  const rows = new Map<string, StatusRow>()
  if (activeRepo) for (const l of list) rows.set(l.path, { path: l.path, repo: activeRepo, branch: l.branch })
  for (const e of w?.entries ?? []) {
    if (!rows.has(e.worktree.path)) rows.set(e.worktree.path, { path: e.worktree.path, repo: e.repo, branch: e.worktree.branch })
  }
  return [...rows.values()]
}

/** `prs`: the branches with an open PR, by repo. Null: gh cannot tell. */
export function rowStatuses(rows: StatusRow[], activities: Record<string, Activity>, prs: Record<string, string[] | null>): Record<string, WorktreeStatus> {
  return Object.fromEntries(rows.map((r) => {
    const open = r.branch !== null && (prs[r.repo]?.includes(r.branch) ?? false)
    return [r.path, worktreeStatus(activities[r.path] ?? 'idle', open)]
  }))
}

export interface StatusReadDeps {
  activity: (path: string) => Promise<Activity>
  /** `soon`: below the usual delay. */
  openPrs: (repo: string, soon: boolean) => Promise<string[] | null>
  activeRepo: () => string | null
  onActivity: (path: string, activity: Activity) => void
  onPrs: (repo: string, branches: string[] | null) => void
}

/**
 * The two halves of a status, read apart: activity costs nothing and must never wait for gh, which is asked once per
 * repo. Only a focus asks sooner, for the repo in front. A failing read keeps what was known.
 */
export function createStatusReads(rows: StatusRow[], deps: StatusReadDeps): { activities: () => Promise<void>; prs: (onFocus: boolean) => Promise<void> } {
  const repos = [...new Set(rows.map((r) => r.repo))]
  return {
    activities: () => eachLimit(rows, READ_CONCURRENCY, ({ path }) => deps.activity(path).then((a) => deps.onActivity(path, a), () => undefined)),
    prs: (onFocus) => eachLimit(repos, READ_CONCURRENCY, (repo) =>
      deps.openPrs(repo, onFocus && repo === deps.activeRepo()).then((branches) => deps.onPrs(repo, branches), () => undefined))
  }
}
