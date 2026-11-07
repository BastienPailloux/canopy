// Contrat IPC entre le renderer et le process principal.
// Chaque task y ajoute ses méthodes.
import type { ModelInfo, PermissionMode, SDKMessage, SessionMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { BaseRef, ChangedFile, PermissionDecision, PermissionRequest, SessionState, SessionSummary, UserContent, Worktree, WorktreeStats } from './types'

export interface RemovalRisks { dirty: number; unpushed: number }

/** A file of the worktree as the editor shows it. `version` identifies the bytes read, to give back to `writeFile`. */
export type FileContent =
  | { kind: 'text'; content: string; version: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number }

/** File content at the comparison base. null: the file does not exist there. */
export type BaseContent =
  | { kind: 'text'; content: string }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'notBlob' }

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
  /** Files changed since the merge-base with `base` (default: the repo's base branch). Rejects on git failures. */
  codeChanges(cwd: string, base?: string): Promise<{ base: BaseRef; files: ChangedFile[] }>
  /** Local and remote branches one can compare against. */
  codeBranches(cwd: string): Promise<string[]>
  /** `path` as of the merge-base with `base`. Use the file's `oldPath` for a rename. */
  readBase(cwd: string, base: string, path: string): Promise<BaseContent | null>
  /** Rejects for a path that leaves the worktree, links included. */
  readFile(cwd: string, path: string): Promise<FileContent>
  /**
   * Resolves the new version. With `expectedVersion`, rejects with FILE_CHANGED (see `isFileChanged`)
   * if the file is no longer what was read.
   */
  writeFile(cwd: string, path: string, content: string, expectedVersion?: string): Promise<string>
  /** Watches the worktrees `repo` lists now, and no other: emits `code:changed` `{ cwd }` after changes. */
  watchWorktrees(repo: string): Promise<void>
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
