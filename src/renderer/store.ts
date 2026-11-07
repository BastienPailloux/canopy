import { create } from 'zustand'
import type { Worktree } from '../shared/types'

export type View = 'sessions' | 'code'

/** A file the Code view must open as soon as it shows. */
export interface CodeRequest { cwd: string; path: string; mode: 'code' | 'diff'; seq: number }

interface AppState {
  repo: string | null
  /** Path of the active worktree. */
  worktree: string | null
  worktrees: Worktree[]
  view: View
  codeRequest: CodeRequest | null
  /** Opens the Code view of `cwd` on `path`. */
  openInCode: (cwd: string, path: string, mode: 'code' | 'diff') => void
  /** The Code view took request `seq`: a later mount must not apply it again. */
  clearCodeRequest: (seq: number) => void
  setRepo: (repo: string | null) => void
  setWorktrees: (list: Worktree[]) => void
  setWorktree: (path: string | null) => void
  setView: (view: View) => void
}

let requestCount = 0

export const useApp = create<AppState>((set) => ({
  repo: null,
  worktree: null,
  worktrees: [],
  view: 'sessions',
  codeRequest: null,
  openInCode: (cwd, path, mode) =>
    set(() => ({ worktree: cwd, view: 'code', codeRequest: { cwd, path, mode, seq: ++requestCount } })),
  clearCodeRequest: (seq) => set((s) => (s.codeRequest?.seq === seq ? { codeRequest: null } : s)),
  setRepo: (repo) => set({ repo, worktree: null, worktrees: [] }),
  // Keeps the selection if it still exists, else falls back to the main worktree.
  setWorktrees: (worktrees) =>
    set((s) => ({
      worktrees,
      worktree: worktrees.some((w) => w.path === s.worktree)
        ? s.worktree
        : (worktrees.find((w) => w.isMain) ?? worktrees[0])?.path ?? null
    })),
  setWorktree: (worktree) => set({ worktree }),
  setView: (view) => set({ view })
}))

export function worktreeLabel(w: Worktree): string {
  return w.branch ?? `(détaché) ${w.head.slice(0, 7)}`
}

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}
