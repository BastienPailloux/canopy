// Contrat IPC entre le renderer et le process principal.
// Chaque task y ajoute ses méthodes.
import type { ModelInfo, PermissionMode, SessionMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision, SessionSummary, UserContent, Worktree, WorktreeStats } from './types'

export interface RemovalRisks { dirty: number; unpushed: number }

export interface StartSessionOptions { content: UserContent; resumeId?: string; model?: string; mode?: PermissionMode }

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
  /** Resolves the session's localId. Resuming a session already live resolves its existing localId. */
  startSession(cwd: string, o: StartSessionOptions): Promise<string>
  /** Rejects if the session has ended: resume it with `startSession`. */
  sendToSession(localId: string, content: UserContent): Promise<void>
  interruptSession(localId: string): Promise<void>
  setSessionMode(localId: string, mode: PermissionMode): Promise<void>
  setSessionModel(localId: string, model: string): Promise<void>
  stopSession(localId: string): Promise<void>
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>
  listSessions(cwd: string): Promise<SessionSummary[]>
  sessionHistory(cwd: string, sessionId: string): Promise<SessionMessage[]>
  sessionActivity(cwd: string): Promise<'waiting' | 'working' | 'idle'>
  sessionCommands(localId: string): Promise<SlashCommand[]>
  sessionModels(localId: string): Promise<ModelInfo[]>
  /**
   * Subscribe to a main-process event. Sessions emit `session:message`, `session:permission`,
   * `session:permissionCancelled` and `session:state`, with the payloads of `SessionEvents`.
   * Returns the unsubscribe function.
   */
  on(event: string, cb: (payload: unknown) => void): () => void
}
