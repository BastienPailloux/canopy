import { isUnder, type Workspace, type WorkspaceEntry, type Worktree } from '../../shared/types'

export interface EntrySection {
  id: string
  /** Null when the workspace is one repo: a plain list. */
  title: string | null
  entries: WorkspaceEntry[]
}

export function worktreeLabel(w: Pick<Worktree, 'branch' | 'head'>): string {
  return w.branch ?? `(détaché) ${w.head.slice(0, 7)}`
}

export const workspaceRepos = (w: Workspace): string[] => [...new Set(w.entries.map((e) => e.repo))]

export const isSingleRepo = (w: Workspace): boolean => workspaceRepos(w).length <= 1

export const repoWorktrees = (w: Workspace, repo: string): Worktree[] => w.entries.filter((e) => e.repo === repo).map((e) => e.worktree)

/** Where a workspace opens: a real repo before the parent one. */
export const defaultEntry = (w: Workspace): WorkspaceEntry | undefined => w.entries.find((e) => e.group === 'main') ?? w.entries[0]

export function entryLabel(e: WorkspaceEntry, singleRepo: boolean): string {
  if (singleRepo) return worktreeLabel(e.worktree)
  if (e.group === 'space') return 'Espace'
  if (e.group === 'main') return e.repoName
  return `${e.repoName} · ${worktreeLabel(e.worktree)}`
}

/** Main repos, one section per feature, then the rest. Sections with nothing to show are left out. */
export function groupEntries(w: Workspace): EntrySection[] {
  if (isSingleRepo(w)) return [{ id: 'all', title: null, entries: w.entries }]
  const of = (group: WorkspaceEntry['group']): WorkspaceEntry[] => w.entries.filter((e) => e.group === group)
  const features = [...new Set(of('feature').map((e) => e.feature ?? ''))].sort((a, b) => a.localeCompare(b))
  return [
    { id: 'main', title: 'Principal', entries: [...of('main'), ...of('space')] },
    ...features.map((f) => ({ id: `feature:${f}`, title: f, entries: of('feature').filter((e) => e.feature === f) })),
    { id: 'other', title: 'Autres', entries: of('other') }
  ].filter((s) => s.entries.length > 0)
}

/**
 * A later scan of the same folder. What it misses is gone only if it could tell: entries it could not read stay,
 * and so does the active repo when it stopped at its limit.
 */
export function mergeScan(previous: Workspace, scan: Workspace, activeRepo: string | null): Workspace {
  const found = new Set(scan.entries.map((e) => e.worktree.path))
  const unknown = (e: WorkspaceEntry): boolean => isUnder(scan.failed, e.repo) || isUnder(scan.failed, e.worktree.path) || (scan.truncated && e.repo === activeRepo)
  const kept = previous.entries.filter((e) => !found.has(e.worktree.path) && unknown(e))
  const byRepo = (a: WorkspaceEntry, b: WorkspaceEntry): number => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)
  return { ...scan, entries: [...scan.entries, ...kept].sort(byRepo) }
}

/** What the sidebar reports on: the live list of the active repo first, then every other entry. */
export function entryPaths(w: Workspace | null, list: Worktree[]): string[] {
  return [...new Set([...list.map((l) => l.path), ...(w?.entries ?? []).map((e) => e.worktree.path)])]
}

/** What exists as far as is known: the live list of `repo`, which a scan cannot overrule, and the scan for the other repos. */
export function listedPaths(w: Workspace | null, repo: string, list: Worktree[]): string[] {
  return [...list.map((l) => l.path), ...(w?.entries ?? []).filter((e) => e.repo !== repo).map((e) => e.worktree.path)]
}

/** The paths that reading the live list leaves to read. */
export const outsideList = (paths: string[], list: Worktree[]): string[] => paths.filter((p) => !list.some((l) => l.path === p))

/** The live list of `repo` shows what the last scan does not: a worktree came, left, or changed branch. */
export function listDiffers(w: Workspace | null, repo: string, list: Worktree[]): boolean {
  const shape = (l: Worktree[]): string => l.map((x) => `${x.path}\0${worktreeLabel(x)}`).sort().join('\0\0')
  return shape(w ? repoWorktrees(w, repo) : []) !== shape(list)
}
