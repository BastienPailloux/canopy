import { create } from 'zustand'
import type { Worktree } from '../shared/types'

export type View = 'sessions' | 'code'

interface AppState {
  repo: string | null
  /** Path of the active worktree. */
  worktree: string | null
  worktrees: Worktree[]
  view: View
  setRepo: (repo: string | null) => void
  setWorktrees: (list: Worktree[]) => void
  setWorktree: (path: string | null) => void
  setView: (view: View) => void
}

export const useApp = create<AppState>((set) => ({
  repo: null,
  worktree: null,
  worktrees: [],
  view: 'sessions',
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
