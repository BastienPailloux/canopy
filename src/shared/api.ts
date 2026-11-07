// Contrat IPC entre le renderer et le process principal.
// Chaque task y ajoute ses méthodes.
import type { Worktree, WorktreeStats } from './types'

export interface RemovalRisks { dirty: number; unpushed: number }

export interface CanopyApi {
  /** Native folder picker. Resolves the chosen git repo root, or null if cancelled. Rejects if not a git repo. */
  openRepo(): Promise<string | null>
  /** Re-open a known repo path. Null if it no longer exists or is not a git repo. */
  selectRepo(path: string): Promise<string | null>
  recentRepos(): Promise<string[]>
  listWorktrees(repo: string): Promise<Worktree[]>
  /** Rejects on unreadable files or a corrupt repo: callers must tolerate it. */
  worktreeStats(cwd: string): Promise<WorktreeStats>
  /** `base` defaults to the repo's resolved base ref. */
  createWorktree(repo: string, o: { name: string; branch: string; base?: string }): Promise<Worktree>
  /** Resolves the base ref, then counts uncommitted files and unpushed commits at `path`. */
  removalRisks(repo: string, path: string): Promise<RemovalRisks>
  removeWorktree(repo: string, path: string, force: boolean): Promise<void>
  /** Subscribe to a main-process event. Returns the unsubscribe function. */
  on(event: string, cb: (payload: unknown) => void): () => void
}
