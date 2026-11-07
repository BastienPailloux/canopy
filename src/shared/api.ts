// Contrat IPC entre le renderer et le process principal.
// Chaque task y ajoute ses méthodes.
import type { ModelInfo, PermissionMode, SDKMessage, SessionMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision, PermissionRequest, SessionState, SessionSummary, UserContent, Worktree, WorktreeStats } from './types'

export interface RemovalRisks { dirty: number; unpushed: number }

export interface StartSessionOptions { content: UserContent; resumeId?: string; model?: string; mode?: PermissionMode }

/** Payload of each event emitted by SessionManager, relayed to the renderer as `session:<key>`. */
export interface SessionEvents {
  message: { localId: string; msg: SDKMessage }
  permission: PermissionRequest
  /** A request shown through `permission` no longer needs an answer. */
  permissionCancelled: { requestId: string; localId: string }
  /** The session's commands are complete: fetch `sessionCommands` again. */
  commandsChanged: { localId: string }
  state: { localId: string; state: SessionState; sessionId?: string; error?: string }
}

/** What a repo's own config would run or allow in a session. */
export interface RepoConfig {
  hooks: string[]
  mcpServers: string[]
  allowRules: string[]
  apiKeyHelper: string[]
  statusLine: string[]
  /** Variable names only: values may be secrets. */
  env: string[]
  /** Every top-level key of the settings files, including those not detailed above. */
  settingsKeys: string[]
  /** Config files that exist but could not be read or parsed: anything may be in them. */
  unknownFiles: string[]
}
export interface RepoTrust extends RepoConfig {
  trusted: boolean
  /** Identifies the config listed here, to approve with `trustRepo`. */
  configHash: string
}

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
  /** Opens a web or mail link in the default browser. Rejects for any other scheme. */
  openExternal(url: string): Promise<void>
  /** Paths relative to `cwd` of its tracked and untracked files, without ignored ones. */
  listTree(cwd: string): Promise<string[]>
  /** The config a session at `cwd` would load, and whether its repo approved exactly that config. */
  repoTrust(cwd: string): Promise<RepoTrust>
  /** Approves the config identified by `configHash` for all the worktrees of `cwd`'s repo. */
  trustRepo(cwd: string, configHash: string): Promise<void>
  /**
   * Resolves the session's localId. Resuming a session already live resolves its existing localId.
   * Rejects with `REPO_NOT_TRUSTED` (see `isRepoNotTrusted`) unless the config at `cwd` was approved with `trustRepo`.
   */
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
  /** Requests still unanswered, to show again after a reload. */
  pendingPermissions(): Promise<PermissionRequest[]>
  /**
   * Subscribe to a main-process event, such as the `session:<key>` of `SessionEvents`.
   * Returns the unsubscribe function.
   */
  on(event: string, cb: (payload: unknown) => void): () => void
}
