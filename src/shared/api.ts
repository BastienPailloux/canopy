// Contrat IPC entre le renderer et le process principal.
// Chaque task y ajoute ses méthodes.
import type { ModelInfo, PermissionMode, SDKMessage, SessionMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Activity, BaseRef, ChangedFile, ClaudeAccount, Location, PermissionDecision, PermissionRequest, SearchHit, SessionState, SessionSummary, SymbolLocation, UserContent, Workspace, Worktree, WorktreeStats } from './types'
import type { DepsReport } from './deps'
import type { ShortcutContext } from './shortcuts'
import type { LaunchCandidate, LaunchRequest, LaunchTarget, TemplateFields, TemplateList, Ticket, TicketFields, TicketListEntry, TicketTemplate } from './tickets'
import type { ReleaseNotes, Stash, UpdateState } from './update'
import type {
  LinearChange, LinearComment, LinearConnection, LinearField, LinearIssue, LinearIssueDetail, LinearLaunchRequest, LinearLink,
  LinearListState, LinearStatus, LinearUser, PendingEdit, SaveResult
} from './linear'
import type { Mockup, MockupChanges, MockupFields, MockupList, MockupViewBounds } from './mockups'

export interface RemovalRisks {
  dirty: number
  unpushed: number
  /** Sessions alive in the worktree, idle ones included: removing it stops them. */
  sessions: number
  /** Terminals still running there. */
  terminals: number
}

/** A worktree that left git's list with processes still running in it. */
export interface OrphanedWorktree extends Worktree { repo: string; sessions: number; terminals: number }

export interface NewWorktree {
  /** Folder name. */
  name: string
  /** With `existing`: a local branch, or a remote one as `origin/x`. Else the branch to create. */
  branch: string
  /** What a new branch starts from. Default: the repo's base branch. */
  base?: string
  /** Absolute folder to create it in. Default: `<repo>/.worktrees`. */
  parentDir?: string
  /** Checks out `branch` instead of creating it. */
  existing?: boolean
}

/** What changing the branch of a worktree involves. */
export interface SwitchInfo {
  /** Where it can go: not the branches open in a worktree. */
  branches: string[]
  /** Files that would be set aside. */
  dirty: number
  /** Sessions running there: the files change under them. */
  sessions: number
}

/** A file of the worktree as the editor shows it. `version` identifies the bytes read, to give back to `writeFile`. */
export type FileContent =
  /** `notUtf8`: `content` is a lossy decoding, shown read-only since saving it would corrupt the file. */
  | { kind: 'text'; content: string; version: string; notUtf8?: boolean }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number }

/** File content at the comparison base. null: the file does not exist there. */
export type BaseContent =
  | { kind: 'text'; content: string }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'notBlob' }

export interface StartSessionOptions { content: UserContent; resumeId?: string; model?: string; mode?: PermissionMode
  /** The session was launched from a Linear issue: warn once if Claude has no Linear MCP. */
  expectLinear?: boolean
}

/** Payload of each event emitted by SessionManager, relayed to the renderer as `session:<key>`. */
export interface SessionEvents {
  message: { localId: string; msg: SDKMessage }
  permission: PermissionRequest
  /** A request shown through `permission` no longer needs an answer. */
  permissionCancelled: { requestId: string; localId: string }
  /** The session's commands are complete: fetch `sessionCommands` again. */
  commandsChanged: { localId: string }
  state: { localId: string; state: SessionState; sessionId?: string; error?: string }
  /** A non-blocking remark about the session, shown once. */
  notice: { localId: string; text: string }
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
  /** The `setup` commands of `.canopy/config.json`: they run in a shell with the user's rights. */
  setup: string[]
  /** Its `services`, as `name: command`. */
  services: string[]
  /** Every top-level key of the settings files, including those not detailed above. */
  settingsKeys: string[]
  /** Config files that exist but could not be read or parsed: anything may be in them. */
  unknownFiles: string[]
}
export type TerminalKind = 'shell' | 'setup' | 'service'
export interface TerminalInfo {
  id: string
  cwd: string
  label: string
  kind: TerminalKind
  running: boolean
  /** Set once the process ended. */
  exitCode?: number
  /** The port reserved for a service. */
  port?: number
}

/** Payload of the terminal events, relayed to the renderer as `terminal:<key>`. */
export interface TerminalEvents {
  /** `end`: characters written to this terminal so far, this chunk included. */
  data: { id: string; data: string; end: number }
  exit: { id: string; exitCode: number }
}

export interface RepoTrust extends RepoConfig {
  /** Main worktree root of the repo asked about. */
  repo: string
  trusted: boolean
  /** Identifies the config listed here, to approve with `trustRepo`. */
  configHash: string
}

export interface CanopyApi {
  /** Native folder picker. Resolves the opened folder (a repo root, or a parent of repos), or null if cancelled. Rejects if it holds no git repo. */
  openRepo(): Promise<string | null>
  /** Re-open a known folder. Null if it no longer exists. Rejects if it holds no git repo. */
  selectRepo(path: string): Promise<string | null>
  /** The repos under a folder, with their worktrees. */
  scanWorkspace(root: string): Promise<Workspace>
  /** Path of the worktree last selected in `folder`, if any. */
  lastEntry(folder: string): Promise<string | null>
  setLastEntry(folder: string, path: string): Promise<void>
  /** Remembers the base branch of a repo, shared by its worktrees; null forgets it. Rejects an unknown branch. */
  setRepoBase(repo: string, branch: string | null): Promise<void>
  /** The remembered base branch of a repo, or null. */
  repoBase(repo: string): Promise<string | null>
  recentRepos(): Promise<string[]>
  /** The folder asked for from the terminal (`canopy .`) while the app was launching, if any; the last one wins. Later ones arrive as the `app:openFolder` event. */
  takeOpenFolder(): Promise<string | null>
  listWorktrees(repo: string): Promise<Worktree[]>
  /** Branches of `repo` with an open PR, through one gh call polled at most every 60 s; `soon` allows it sooner. Null if gh cannot tell: the PR is then ignored. */
  openPrs(repo: string, soon?: boolean): Promise<string[] | null>
  /** Whether a session in any worktree, displayed or gone from disk, waits for an answer, in any repo under `path` other than `except`. */
  repoNeedsAttention(path: string, except?: string): Promise<boolean>
  /** Main worktree roots with an approved config. */
  trustedRepos(): Promise<string[]>
  /** Forgets every approval of that repo: its next session asks again. Sessions already running go on. */
  revokeRepo(root: string): Promise<void>
  /** Whether an API key is saved, whether the keychain can store one, and whether the saved key can still be read (false after a re-signed app). The key is never sent back. */
  apiKeyStatus(): Promise<{ set: boolean; encryptionAvailable: boolean; readable: boolean }>
  /** Saves the key in the keychain, or removes it with null. Rejects, storing nothing, if the keychain is unavailable. */
  saveApiKey(key: string | null): Promise<void>
  /** The account sessions use. Cached 5 minutes by the main process; a saved or removed API key refreshes it. Never rejects: a failed read is `unknown`. */
  claudeAccount(): Promise<ClaudeAccount>
  /** Rejects on unreadable files or a corrupt repo: callers must tolerate it. */
  worktreeStats(cwd: string): Promise<WorktreeStats>
  createWorktree(repo: string, o: NewWorktree): Promise<Worktree>
  /** The branch worktrees start from and compare to by default. Null if none resolves. */
  defaultBase(cwd: string): Promise<BaseRef | null>
  /** Uncommitted files and unpushed commits at `path`, and the sessions and terminals alive there. */
  removalRisks(repo: string, path: string): Promise<RemovalRisks>
  /** Removes the worktree, then stops its sessions and terminals. If git refuses, nothing stops. */
  removeWorktree(repo: string, path: string, force: boolean): Promise<void>
  switchInfo(path: string): Promise<SwitchInfo>
  /** Sets the changes aside for the branch left and takes back those of `branch`. `conflict`: they could not be applied, and stay aside. */
  switchBranch(path: string, branch: string): Promise<{ conflict: boolean }>
  /** Worktrees of the repos of the folder `root` that vanished from outside with sessions or terminals still alive. */
  orphanedWorktrees(root: string): Promise<OrphanedWorktree[]>
  /** Tells the main process what quitting would lose: unsaved editor buffers, composer drafts, ticket edits not written. */
  reportUnsaved(counts: { buffers: number; drafts: number; tickets: number; comments: number }): Promise<void>
  /** Tells the main process what is active, so that it greys the shortcuts that would do nothing. */
  reportShortcutContext(ctx: ShortcutContext): Promise<void>
  /** Opens macOS dictation on the focused field. */
  startDictation(): Promise<void>
  /** Where the downloaded update stands. Changes arrive as `update:state` events. */
  updateState(): Promise<UpdateState>
  /** Restarts into the downloaded update, after one question if sessions or terminals run. Does nothing without one. */
  restartToUpdate(): Promise<void>
  /** The answer to `update:collectStash`: the unsaved work to set aside across the restart. */
  submitStash(s: Stash): Promise<void>
  /** The work set aside by the last update restart, once: the file is gone after. */
  takeStash(): Promise<Stash | null>
  /** Notes of the versions installed since the last time the user saw them, newest first. Empty on a fresh install. */
  whatsNew(): Promise<ReleaseNotes[]>
  /** Remembers that the notes of the running version were shown. */
  markWhatsNewSeen(): Promise<void>
  /** Opens a web or mail link in the default browser. Rejects for any other scheme. */
  openExternal(url: string): Promise<void>
  /** Paths relative to `cwd` of its tracked and untracked files, without ignored ones. */
  listTree(cwd: string): Promise<string[]>
  /**
   * Text search in the files of `cwd` (.gitignore honored, links not followed), at most 2000 hits unless `limit`.
   * One search runs per window and `channel`: a new call on the same channel cancels the previous one, which then resolves null.
   * Rejects with a readable message for an invalid regex.
   */
  searchText(cwd: string, q: string, o: { channel: 'panel' | 'bar'; regex?: boolean; caseSensitive?: boolean; limit?: number }): Promise<SearchHit[] | null>
  /**
   * Where the symbol at this 1-based position of the file on disk is defined. In a file that is not TS or JS,
   * or if the language server fails: the text hits of the word there, marked `fallback`.
   */
  definition(cwd: string, path: string, line: number, column: number): Promise<Location[]>
  /** The uses of the symbol at this position, without its declaration. Same fallback as `definition`. */
  references(cwd: string, path: string, line: number, column: number): Promise<Location[]>
  /**
   * Symbols of `cwd` matching `q`, in the projects its server loaded. A new call from the same window cancels
   * the previous one, which then resolves null. Rejects if the language server fails.
   */
  symbols(cwd: string, q: string): Promise<SymbolLocation[] | null>
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
  /** Tickets of the repo whose main checkout holds `repo` (any worktree path works). */
  listTickets(repo: string): Promise<TicketListEntry[]>
  getTicket(repo: string, id: string): Promise<Ticket>
  createTicket(repo: string, fields: TicketFields): Promise<Ticket>
  patchTicket(repo: string, id: string, changes: Partial<TicketFields>): Promise<Ticket>
  duplicateTicket(repo: string, id: string): Promise<Ticket>
  archiveTicket(repo: string, id: string): Promise<void>
  ticketConfig(repo: string): Promise<{ prefix: string; next: number }>
  setTicketPrefix(repo: string, prefix: string): Promise<void>
  ticketLabels(repo: string): Promise<string[]>
  /** Ticket templates of the repo (built-ins are written on first use) and the default one. Changes emit `tickets:changed`. */
  ticketTemplates(repo: string): Promise<TemplateList>
  /** Creates a template (`slug: null`, slug derived from the name) or updates one in place; the slug never changes. */
  saveTicketTemplate(repo: string, slug: string | null, fields: TemplateFields): Promise<TicketTemplate>
  deleteTicketTemplate(repo: string, slug: string): Promise<void>
  setDefaultTicketTemplate(repo: string, slug: string): Promise<void>
  /** Worktrees of `repo` a launch could use, and the branch most ahead of the default one (null: none ahead). */
  launchCandidates(repo: string): Promise<{ worktrees: LaunchCandidate[]; advanced: { branch: string; ahead: number } | null }>
  /**
   * Creates the ticket's branch in a new worktree, or in a free existing one, and links the ticket to it.
   * A failed launch writes nothing in the ticket. A relaunch replaces the linked branch.
   */
  launchTicket(repo: string, req: LaunchRequest): Promise<{ worktree: string; ticket: Ticket }>
  /** Watches the tickets of `repo` for this window, and no other repo: emits `tickets:changed` `{ repo }` (main root). */
  watchTickets(repo: string): Promise<void>
  /**
   * The base remembered for the branch checked out at `cwd`. `lost`: that base no longer exists locally,
   * and is forgotten after this answer. Null: none.
   */
  branchBase(cwd: string): Promise<{ base: string } | { lost: string } | null>
  /** The last report of the repo holding `repo` (main root); null before its first check. Emits `deps:changed` `{ repo }`. */
  depsReport(repo: string): Promise<DepsReport | null>
  depsRecheck(repo: string): Promise<DepsReport>
  /** Critical dependencies in `path` (a recent entry or a repo), without `except`. */
  depsCritical(path: string, except?: string): Promise<number>
  depsBanner(repo: string): Promise<boolean>
  depsDismissBanner(repo: string): Promise<void>
  /** Starts `req.branch` like a ticket launch; nothing is written in the repo. */
  depsLaunch(repo: string, req: { branch: string; target: LaunchTarget }): Promise<{ worktree: string }>
  /**
   * The Linear connection. Emits `linear:changed` `{ ids }` on a list or queue change (the issues touched, maybe none)
   * and `{}` on a connection change (anything may have changed).
   */
  linearConnection(): Promise<LinearConnection>
  /** Interactive: may open the browser for Linear's consent. Once connected, the queue is resent and the list refreshed. */
  linearConnect(): Promise<LinearConnection>
  /**
   * Forgets the Linear tokens and the cached list; the links of launched issues stay. Rejects with
   * `Des modifications Linear n'ont pas été envoyées.` while edits are queued, unless `force` (the queue is then dropped).
   */
  linearDisconnect(force?: boolean): Promise<void>
  /**
   * The cached list (no network); `repo` picks whose launched issues stay listed (linked, branch still local).
   * `links: false` skips reading the branches of every linked repo again (an event that changed no link).
   */
  linearList(repo: string, links?: boolean): Promise<LinearListState>
  /** Asks Linear again; an error keeps the last list and is reported in `error`. */
  linearRefresh(repo: string): Promise<LinearListState>
  linearAckDepartures(ids: string[]): Promise<void>
  /** The issue with its sub-issues and comments, read from Linear. */
  linearIssue(id: string): Promise<LinearIssueDetail>
  linearTeamOptions(teamId: string): Promise<{ statuses: LinearStatus[]; labels: string[]; users: LinearUser[] }>
  /** Queues the change and sends it; a `sent` save refreshes the list. */
  linearSave(id: string, c: LinearChange): Promise<SaveResult>
  /** Edits not sent yet (failed, held or in flight). */
  linearPending(): Promise<PendingEdit[]>
  /** Drops `fields` (every field when omitted) of the queued edit of `id`. */
  linearDiscard(id: string, fields?: LinearField[]): Promise<void>
  linearComment(id: string, body: string): Promise<LinearComment>
  /** Creates the issue's branch like `launchTicket` and links it in Canopy only; nothing is written in Linear. */
  linearLaunch(repo: string, req: LinearLaunchRequest): Promise<{ worktree: string; issue: LinearIssue }>
  /** Launched Linear issues of `repo`'s main checkout, by issue id. */
  linearLinks(repo: string): Promise<Record<string, LinearLink>>
  /** Mockups of the repo whose main checkout holds `repo`; an unreadable registry is reported, never rewritten. */
  listMockups(repo: string): Promise<MockupList>
  /** Registers the claude.ai artifact at `url`. Already there: returns it, linked to `fields.ticket` if it had no ticket. */
  addMockup(repo: string, url: string, fields?: Partial<MockupFields>): Promise<Mockup>
  /** `ticket: null` removes the link; a `title` sets `titleSet` unless given. */
  patchMockup(repo: string, id: string, changes: MockupChanges): Promise<Mockup>
  /** Forgets the mockup in Canopy; it stays on claude.ai. */
  removeMockup(repo: string, id: string): Promise<void>
  /** Watches the mockups of `repo` for this window, and no other repo: emits `mockups:changed` `{ repo }` (main root). */
  watchMockups(repo: string): Promise<void>
  /**
   * Shows the claude.ai view of this window over `bounds` (window content pixels), loading `url` unless it is already
   * the one shown. Hide it before any modal: the native view is drawn above the page.
   * Emits `mockups:title` (`MockupTitleEvent`) and `mockups:viewError` (`MockupViewErrorEvent`) on `on(...)`.
   */
  showMockupView(url: string, bounds: MockupViewBounds): Promise<void>
  setMockupViewBounds(bounds: MockupViewBounds): Promise<void>
  hideMockupView(): Promise<void>
  reloadMockupView(): Promise<void>
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
  sessionActivity(cwd: string): Promise<Activity>
  sessionCommands(localId: string): Promise<SlashCommand[]>
  sessionModels(localId: string): Promise<ModelInfo[]>
  /** Requests still unanswered, to show again after a reload. */
  pendingPermissions(): Promise<PermissionRequest[]>
  /** The ports reserved for the services of `cwd`, by service name. Emits `terminal:portsChanged` `{ cwd }` once services start. */
  terminalPorts(cwd: string): Promise<Record<string, number>>
  /** A plain interactive shell in `cwd`: needs no trust. Rejects with a readable message if `cwd` is gone. */
  createTerminal(cwd: string): Promise<TerminalInfo>
  /** Terminals of `cwd`, running or ended. They outlive views, worktree and repo changes. */
  listTerminals(cwd: string): Promise<TerminalInfo[]>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  /** Ends the process. The terminal stays listed, ended. */
  killTerminal(id: string): Promise<void>
  /** Ends the process if needed and forgets the terminal. */
  removeTerminal(id: string): Promise<void>
  /** The last 2000 lines and the `end` of the `terminal:data` events they include. */
  terminalSnapshot(id: string): Promise<{ data: string; end: number }>
  /**
   * Runs the `setup` commands of `.canopy/config.json` in one terminal. Null if there are none.
   * Rejects with `REPO_NOT_TRUSTED` unless that exact config was approved with `trustRepo`.
   */
  runSetup(cwd: string): Promise<TerminalInfo | null>
  /**
   * Starts the `services` (only `name` if given), each in a terminal with its `portEnv` (`PORT` by default) and the
   * `PORT_<NAME>` of all of them set to reserved ports, and restarts one already running. Same trust rule as `runSetup`.
   */
  runServices(cwd: string, name?: string): Promise<TerminalInfo[]>
  /**
   * Subscribe to a main-process event, such as the `session:<key>` of `SessionEvents`.
   * Returns the unsubscribe function.
   */
  on(event: string, cb: (payload: unknown) => void): () => void
}
