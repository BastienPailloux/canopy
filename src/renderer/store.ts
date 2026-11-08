import { create } from 'zustand'
import type { OrphanedWorktree } from '../shared/api'
import type { Workspace, WorkspaceEntry, Worktree } from '../shared/types'
import { defaultEntry, mergeScan, repoWorktrees, worktreeLabel } from './shell/workspaceList'

export { worktreeLabel }

export type View = 'sessions' | 'code' | 'tickets' | 'mockups'

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
  /** Worktrees of the workspace deleted from outside, kept reachable for what still runs in them. */
  orphans: OrphanedWorktree[]
  view: View
  /** Ticket open in the editor of the Tickets view; null: the list. */
  openTicket: string | null
  /** Ticket highlighted in the list. */
  selectedTicket: string | null
  /** Mockup open in the edit screen (4b); `'new'`: one Claude is to create; null: the gallery. */
  openMockup: string | null
  /** Mockup highlighted in the gallery. */
  selectedMockup: string | null
  /** The ticket the mockup being created (`openMockup: 'new'`) is to be linked to once published. */
  pendingMockupTicket: string | null
  /** Branch each worktree is compared against when the user picked one; absent: the default branch. */
  bases: Record<string, string>
  codeRequest: CodeRequest | null
  /** Opens the Code view of `cwd` on `path`, at `line` and `column` (1-based) if given. */
  openInCode: (cwd: string, path: string, mode: 'code' | 'diff', line?: number, column?: number) => void
  /** The Code view took request `seq`: a later mount must not apply it again. */
  clearCodeRequest: (seq: number) => void
  /**
   * Takes a scan. Of the open folder, it is merged, see `mergeScan`. The selection stays while its entry exists, then
   * goes to what lives on of the active repo, then to the default entry. A scan with nothing in it closes nothing.
   * Another folder clears `openError`; entering the open one again is up to the caller.
   */
  setWorkspace: (workspace: Workspace) => void
  /** Makes the repo of `entry` active on that worktree. What other repos hold stays, all of it is kept by path. */
  selectEntry: (entry: WorkspaceEntry) => void
  /** The same for a worktree gone from disk: no scan lists it, its repo may be gone too. */
  selectOrphan: (orphan: OrphanedWorktree) => void
  /** Counts the changes of a remembered base: what is numbered against it is stale. */
  baseEpoch: number
  baseChanged: () => void
  setOpenError: (message: string | null) => void
  setWorktrees: (list: Worktree[]) => void
  setOrphans: (list: OrphanedWorktree[]) => void
  setWorktree: (path: string | null) => void
  setView: (view: View) => void
  setOpenTicket: (id: string | null) => void
  setSelectedTicket: (id: string | null) => void
  setOpenMockup: (id: string | null) => void
  setSelectedMockup: (id: string | null) => void
  setPendingMockupTicket: (id: string | null) => void
  setBase: (cwd: string, base: string | undefined) => void
}

let requestCount = 0

const noRepoMessage = (root: string): string => `Aucun repo git dans ${root}`

type Selection = Pick<AppState,
  'repo' | 'worktree' | 'worktrees' | 'openTicket' | 'selectedTicket' | 'openMockup' | 'selectedMockup' | 'pendingMockupTicket'>

/** Another repo has other tickets and mockups: the ones open or selected would point at the repo left. */
function selection(s: Selection, workspace: Workspace, repo: string, worktree: string): Partial<Selection> {
  return repo === s.repo
    ? { worktree }
    : {
        repo, worktree, worktrees: repoWorktrees(workspace, repo), openTicket: null, selectedTicket: null,
        openMockup: null, selectedMockup: null, pendingMockupTicket: null
      }
}

export const useApp = create<AppState>((set) => ({
  workspace: null,
  openError: null,
  repo: null,
  worktree: null,
  worktrees: [],
  orphans: [],
  view: 'sessions',
  openTicket: null,
  selectedTicket: null,
  openMockup: null,
  selectedMockup: null,
  pendingMockupTicket: null,
  bases: {},
  codeRequest: null,
  openInCode: (cwd, path, mode, line, column) =>
    set(() => ({ worktree: cwd, view: 'code', codeRequest: { cwd, path, mode, line, column, seq: ++requestCount } })),
  clearCodeRequest: (seq) => set((s) => (s.codeRequest?.seq === seq ? { codeRequest: null } : s)),
  setWorkspace: (scan) => set((s) => {
    const same = s.workspace?.root === scan.root
    const workspace = s.workspace && same ? mergeScan(s.workspace, scan, s.repo) : scan
    const first = defaultEntry(workspace)
    if (!first) return { openError: noRepoMessage(scan.root) }
    const orphans = same ? s.orphans : []
    // A rescan says nothing of a folder that failed to open, only of its own last finding.
    const openError = same && s.openError !== noRepoMessage(scan.root) ? s.openError : null
    const base = { workspace, orphans, openError }
    const selected = (p: { path: string }): boolean => p.path === s.worktree
    if (workspace.entries.some((e) => e.repo === s.repo && selected(e.worktree)) || orphans.some(selected)) return base
    const heir = orphans.find((o) => o.repo === s.repo)
    return { ...base, ...(heir ? { worktree: heir.path } : selection(s, workspace, first.repo, first.worktree.path)) }
  }),
  selectEntry: (e) => set((s) => (s.workspace ? selection(s, s.workspace, e.repo, e.worktree.path) : s)),
  selectOrphan: (o) => set((s) => (s.workspace ? selection(s, s.workspace, o.repo, o.path) : s)),
  baseEpoch: 0,
  baseChanged: () => set((s) => ({ baseEpoch: s.baseEpoch + 1 })),
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
  setOpenTicket: (openTicket) => set({ openTicket }),
  setSelectedTicket: (selectedTicket) => set({ selectedTicket }),
  setOpenMockup: (openMockup) => set({ openMockup }),
  setSelectedMockup: (selectedMockup) => set({ selectedMockup }),
  setPendingMockupTicket: (pendingMockupTicket) => set({ pendingMockupTicket }),
  setBase: (cwd, base) => set((s) => {
    const { [cwd]: _old, ...rest } = s.bases
    return { bases: base === undefined ? rest : { ...rest, [cwd]: base } }
  })
}))

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}
