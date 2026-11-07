import { create } from 'zustand'
import type { OrphanedWorktree } from '../shared/api'
import type { Workspace, WorkspaceEntry, Worktree } from '../shared/types'
import { defaultEntry, repoWorktrees, worktreeLabel } from './shell/workspaceList'

export { worktreeLabel }

export type View = 'sessions' | 'code'

/** A file the Code view must open as soon as it shows. */
export interface CodeRequest { cwd: string; path: string; mode: 'code' | 'diff'; /** 1-based line to reveal. */ line?: number; /** 1-based column of `line` for the cursor. */ column?: number; seq: number }

interface AppState {
  /** The folder opened and what its last scan found. */
  workspace: Workspace | null
  /** Why the last folder could not be opened. */
  openError: string | null
  /** The active repo: the one of the selected entry. */
  repo: string | null
  /** Path of the active worktree. */
  worktree: string | null
  worktrees: Worktree[]
  /** Worktrees deleted from outside, kept reachable for what still runs in them. */
  orphans: OrphanedWorktree[]
  view: View
  /** Branch each worktree is compared against when the user picked one; absent: the default branch. */
  bases: Record<string, string>
  codeRequest: CodeRequest | null
  /** Opens the Code view of `cwd` on `path`, at `line` and `column` (1-based) if given. */
  openInCode: (cwd: string, path: string, mode: 'code' | 'diff', line?: number, column?: number) => void
  /** The Code view took request `seq`: a later mount must not apply it again. */
  clearCodeRequest: (seq: number) => void
  /** Takes a scan. The selection stays while its entry exists, else moves to the default entry. */
  setWorkspace: (workspace: Workspace) => void
  /** Makes the repo of `entry` active on that worktree. What other repos hold stays, all of it is kept by path. */
  selectEntry: (entry: WorkspaceEntry) => void
  setOpenError: (message: string | null) => void
  setWorktrees: (list: Worktree[]) => void
  setOrphans: (list: OrphanedWorktree[]) => void
  setWorktree: (path: string | null) => void
  setView: (view: View) => void
  setBase: (cwd: string, base: string | undefined) => void
}

let requestCount = 0

type Selection = Pick<AppState, 'repo' | 'worktree' | 'worktrees' | 'orphans'>

function selection(s: Selection, workspace: Workspace, e: WorkspaceEntry): Partial<Selection> {
  if (e.repo === s.repo) return { worktree: e.worktree.path }
  return { repo: e.repo, worktree: e.worktree.path, worktrees: repoWorktrees(workspace, e.repo), orphans: [] }
}

export const useApp = create<AppState>((set) => ({
  workspace: null,
  openError: null,
  repo: null,
  worktree: null,
  worktrees: [],
  orphans: [],
  view: 'sessions',
  bases: {},
  codeRequest: null,
  openInCode: (cwd, path, mode, line, column) =>
    set(() => ({ worktree: cwd, view: 'code', codeRequest: { cwd, path, mode, line, column, seq: ++requestCount } })),
  clearCodeRequest: (seq) => set((s) => (s.codeRequest?.seq === seq ? { codeRequest: null } : s)),
  setWorkspace: (workspace) => set((s) => {
    const first = defaultEntry(workspace)
    if (!first) return { workspace, repo: null, worktree: null, worktrees: [], orphans: [], openError: `Aucun repo git dans ${workspace.root}` }
    const inRepo = workspace.entries.filter((e) => e.repo === s.repo)
    // An orphan is in no scan, and stays reachable as long as its repo is there.
    const kept = inRepo.some((e) => e.worktree.path === s.worktree) || (inRepo.length > 0 && s.orphans.some((o) => o.path === s.worktree))
    return { workspace, openError: null, ...(kept ? {} : selection(s, workspace, first)) }
  }),
  selectEntry: (entry) => set((s) => (s.workspace ? selection(s, s.workspace, entry) : s)),
  setOpenError: (openError) => set({ openError }),
  setOrphans: (orphans) => set({ orphans }),
  // Keeps the selection if it can still be reached, else falls back to the main worktree.
  setWorktrees: (worktrees) =>
    set((s) => ({
      worktrees,
      worktree: [...worktrees, ...s.orphans].some((w) => w.path === s.worktree)
        ? s.worktree
        : (worktrees.find((w) => w.isMain) ?? worktrees[0])?.path ?? null
    })),
  setWorktree: (worktree) => set({ worktree }),
  setView: (view) => set({ view }),
  setBase: (cwd, base) => set((s) => {
    const { [cwd]: _old, ...rest } = s.bases
    return { bases: base === undefined ? rest : { ...rest, [cwd]: base } }
  })
}))

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}
