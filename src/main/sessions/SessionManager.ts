import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  CanUseTool, getSessionMessages, listSessions, ModelInfo, Options, PermissionMode, PermissionResult, PermissionUpdate,
  query, Query, SDKMessage, SDKResultMessage, SDKUserMessage, SessionMessage, SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvents, StartSessionOptions } from '../../shared/api'
import { attachmentNote } from '../../shared/attachments'
import { RepoNotTrustedError } from '../../shared/errors'
import type { PermissionDecision, PermissionRequest, SessionState, SessionSummary, UserContent, UserDocument } from '../../shared/types'
import { createInputQueue, type InputQueue } from './inputQueue'

export interface SessionManagerDeps {
  query: typeof query
  listSessions: typeof listSessions
  getSessionMessages: typeof getSessionMessages
  /** The login shell env. Synchronous because `start` is. */
  env: () => NodeJS.ProcessEnv
  /** Required in the packaged app, where the SDK cannot run the binary from inside the asar. May throw: `start` reports it. */
  pathToClaudeCodeExecutable?: () => string | undefined
  /** Whether sessions may run in this main worktree root. Unset means nothing is trusted. */
  isTrusted?: (repoRoot: string) => boolean
  /**
   * Where each session keeps a copy of the documents sent to it, in a folder of its own deleted when it ends.
   * Emptied at startup: no session outlives the app. Unset, documents are sent with no copy.
   */
  attachmentsDir?: string
}

type EventMap = { [K in keyof SessionEvents]: [SessionEvents[K]] }
type CanUseToolOptions = Parameters<CanUseTool>[2]
type TurnState = 'running' | 'idle' | 'error'

interface PendingPermission {
  request: PermissionRequest
  /** What "always" may persist. */
  rules: PermissionUpdate[]
  settle(result: PermissionResult): void
}

interface Session {
  localId: string
  sessionId: string
  cwd: string
  title: string
  startedAt: number
  query: Query
  input: InputQueue<SDKUserMessage>
  mode: PermissionMode
  turn: TurnState
  /** Why `turn` is 'error'. */
  error?: string
  pending: Map<string, PendingPermission>
  terminalCommands: Set<string>
  initialized: boolean
  reported?: SessionState
  closed: boolean
}

const WITHDRAWN: PermissionResult = { behavior: 'deny', message: 'Demande annulée.' }
const INTERRUPTED: readonly unknown[] = ['aborted_tools', 'aborted_streaming']

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isEmpty = (c: UserContent): boolean => c.text === '' && !c.images?.length && !c.documents?.length
const currentState = (s: Session): SessionState => (s.pending.size > 0 ? 'waiting' : s.turn)

/** `subtype` says nothing: an interruption is an error result on a usable session, a lost login is a "success". */
function turnAfter(result: SDKResultMessage): TurnState {
  return !result.is_error || INTERRUPTED.includes(result.terminal_reason) ? 'idle' : 'error'
}

function resultError(result: SDKResultMessage): string {
  return result.subtype === 'success' ? result.result : result.errors.join('\n')
}

/** The copies hold the user's documents: no other local user may read them. */
const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

/** A name of its own in `dir`, from the file's name with no path in it. */
function freeName(dir: string, name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '')
  const base = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'document.pdf' : cleaned
  const ext = extname(base)
  const stem = base.slice(0, base.length - ext.length)
  let candidate = base
  for (let n = 2; existsSync(join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`
  return candidate
}

/** `copies` holds the path of each document's copy, in order: their notes come last. */
function toUserMessage(c: UserContent, copies: string[] = []): SDKUserMessage {
  const text = c.text === '' ? [] : [{ type: 'text' as const, text: c.text }]
  const images = (c.images ?? []).map((i) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.base64 }
  }))
  const documents = (c.documents ?? []).map((d) => ({
    type: 'document' as const,
    source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: d.base64 },
    title: d.name
  }))
  const notes = copies.map((path, i) => ({ type: 'text' as const, text: attachmentNote(c.documents?.[i]?.name ?? '', path) }))
  return { type: 'user', message: { role: 'user', content: [...text, ...images, ...documents, ...notes] }, parent_tool_use_id: null }
}

/** Runs concurrent Agent SDK sessions. Each one lives until `stop` or its own failure, whatever the UI does. */
export class SessionManager extends EventEmitter<EventMap> {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly deps: SessionManagerDeps) {
    super()
    if (deps.attachmentsDir) {
      rmSync(deps.attachmentsDir, { recursive: true, force: true })
      mkdirSync(deps.attachmentsDir, { recursive: true, mode: PRIVATE_DIR })
    }
  }

  /**
   * Resuming a session live in Canopy reuses it. Nothing detects one open in an external CLI: both
   * would write to the same file and the conversation would fork silently.
   *
   * Throws `RepoNotTrustedError` unless the repo is trusted: a session loads the repo's config, and
   * nothing limits that to safe parts. `repoRoot` is the main worktree root of `cwd`, default `cwd`.
   */
  start(cwd: string, o: StartSessionOptions & { repoRoot?: string }): string {
    if (this.deps.isTrusted?.(o.repoRoot ?? cwd) !== true) throw new RepoNotTrustedError()

    const existing = [...this.sessions.values()].find((s) => s.sessionId === o.resumeId)
    if (existing) {
      this.send(existing.localId, o.content)
      return existing.localId
    }

    const localId = randomUUID()
    const sessionId = o.resumeId || randomUUID()
    const input = createInputQueue<SDKUserMessage>()
    let session: Session | undefined
    const canUseTool: CanUseTool = (toolName, toolInput, opts) =>
      session ? this.askPermission(session, toolName, toolInput, opts) : Promise.resolve(WITHDRAWN)

    let q: Query
    try {
      q = this.deps.query({ prompt: input.iterable, options: this.options(cwd, sessionId, o, canUseTool, this.makeCopiesDir(localId)) })
    } catch (err) {
      input.close()
      // Deferred so that the caller holds the localId before hearing about it.
      setImmediate(() => this.notify('state', { localId, state: 'error', sessionId, error: errorMessage(err) }))
      return localId
    }

    const s: Session = {
      localId, sessionId, cwd, title: o.content.text, startedAt: Date.now(), query: q, input,
      mode: o.mode ?? 'default', turn: 'idle', pending: new Map(), terminalCommands: new Set(), initialized: false, closed: false
    }
    session = s
    this.sessions.set(localId, s)
    this.deliver(s, o.content)
    // Deferred like the failure above: the first event may be the only one, and it carries the sessionId.
    setImmediate(() => {
      this.syncState(s)
      void this.pump(s)
    })
    return localId
  }

  send(localId: string, content: UserContent): void {
    const s = this.sessions.get(localId)
    if (!s) throw new Error('Cette session est terminée.')
    this.deliver(s, content)
    this.syncState(s)
  }

  async interrupt(localId: string): Promise<void> {
    await this.sessions.get(localId)?.query.interrupt()
  }

  async setMode(localId: string, mode: PermissionMode): Promise<void> {
    const s = this.sessions.get(localId)
    if (!s) return
    await s.query.setPermissionMode(mode)
    s.mode = mode
  }

  async setModel(localId: string, model: string): Promise<void> {
    await this.sessions.get(localId)?.query.setModel(model)
  }

  stop(localId: string): void {
    const s = this.sessions.get(localId)
    if (s) this.close(s, 'stopped')
  }

  stopAll(): void {
    for (const s of [...this.sessions.values()]) this.close(s, 'stopped')
  }

  /** Ends the sessions of a worktree, when it is removed. */
  stopIn(cwd: string): void {
    for (const s of [...this.sessions.values()]) if (s.cwd === cwd) this.close(s, 'stopped')
  }

  resolvePermission(requestId: string, d: PermissionDecision): void {
    for (const s of this.sessions.values()) {
      const p = s.pending.get(requestId)
      if (!p) continue
      if (d.allow) {
        const updatedPermissions = d.always && p.rules.length > 0 ? { updatedPermissions: p.rules } : {}
        p.settle({ behavior: 'allow', updatedInput: d.updatedInput ?? p.request.input, ...updatedPermissions })
      } else {
        p.settle({ behavior: 'deny', message: d.message })
      }
      this.syncState(s)
      return
    }
  }

  async list(cwd: string): Promise<SessionSummary[]> {
    // A worktree deleted from outside may not be listable, and its live sessions must stay reachable.
    const disk = await this.deps.listSessions({ dir: cwd, includeWorktrees: false }).catch(() => [])
    const live = new Map([...this.sessions.values()].map((s) => [s.sessionId, s]))
    const rows = disk.map((info): SessionSummary => {
      const s = live.get(info.sessionId)
      live.delete(info.sessionId)
      return {
        sessionId: info.sessionId,
        title: info.customTitle ?? info.summary,
        lastModified: info.lastModified,
        gitBranch: info.gitBranch,
        live: s !== undefined,
        state: s ? currentState(s) : 'stopped',
        ...(s ? { localId: s.localId, mode: s.mode } : {})
      }
    })
    const notOnDiskYet = [...live.values()].filter((s) => s.cwd === cwd).map((s): SessionSummary => ({
      sessionId: s.sessionId, title: s.title, lastModified: s.startedAt, live: true, state: currentState(s),
      localId: s.localId, mode: s.mode
    }))
    return [...notOnDiskYet, ...rows]
  }

  history(cwd: string, sessionId: string): Promise<SessionMessage[]> {
    return this.deps.getSessionMessages(sessionId, { dir: cwd })
  }

  activity(cwd: string): 'waiting' | 'working' | 'idle' {
    const states = [...this.sessions.values()].filter((s) => s.cwd === cwd).map(currentState)
    if (states.includes('waiting')) return 'waiting'
    return states.includes('running') ? 'working' : 'idle'
  }

  /** Sessions in the middle of a turn or waiting for an answer: what quitting would cut short. */
  runningCount(): number {
    return [...this.sessions.values()].filter((s) => ['running', 'waiting'].includes(currentState(s))).length
  }

  /** Sessions alive in a worktree, idle ones included: what removing it would end. */
  liveCount(cwd: string): number {
    return [...this.sessions.values()].filter((s) => s.cwd === cwd).length
  }

  /** Requests still waiting for an answer, for a window that missed their `permission` event. */
  pendingPermissions(): PermissionRequest[] {
    return [...this.sessions.values()].flatMap((s) => [...s.pending.values()].map((p) => p.request))
  }

  /** Commands usable from the composer. Terminal-only ones are only known after `commandsChanged`. */
  async commands(localId: string): Promise<SlashCommand[]> {
    const s = this.sessions.get(localId)
    if (!s) return []
    const all = await s.query.supportedCommands()
    return all.filter((c) => !c.name.startsWith('__') && !s.terminalCommands.has(c.name))
  }

  async models(localId: string): Promise<ModelInfo[]> {
    return (await this.sessions.get(localId)?.query.supportedModels()) ?? []
  }

  private options(
    cwd: string,
    sessionId: string,
    o: StartSessionOptions,
    canUseTool: CanUseTool,
    copiesDir: string | undefined
  ): Options {
    // The injected env alone: it already holds the login shell env (USER included) and never ELECTRON_RUN_AS_NODE.
    // The Artifact tool (mockups on claude.ai) only exists with CLAUDE_CODE_ARTIFACT=1.
    const env: NodeJS.ProcessEnv = { ...this.deps.env(), CLAUDE_CODE_ARTIFACT: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const pathToClaudeCodeExecutable = this.deps.pathToClaudeCodeExecutable?.()
    return {
      cwd,
      env,
      canUseTool,
      includePartialMessages: true,
      permissionMode: o.mode ?? 'default',
      ...(o.resumeId ? { resume: o.resumeId } : { sessionId }),
      ...(o.model ? { model: o.model } : {}),
      // Claude reads the copies there with no permission prompt.
      ...(copiesDir ? { additionalDirectories: [copiesDir] } : {}),
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {})
    }
  }

  private copiesDir(localId: string): string | undefined {
    return this.deps.attachmentsDir ? join(this.deps.attachmentsDir, localId) : undefined
  }

  /** Made before Claude Code starts, which checks the directories it is given. Undefined if it cannot be made. */
  private makeCopiesDir(localId: string): string | undefined {
    const dir = this.copiesDir(localId)
    if (!dir) return undefined
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR })
      return dir
    } catch (err) {
      console.error('SessionManager: could not make the copies folder', err)
      return undefined
    }
  }

  /** Copies each document into the session's folder. No copy at all if one fails: the message still goes. */
  private keepCopies(s: Session, documents: UserDocument[]): string[] {
    const dir = this.copiesDir(s.localId)
    if (!dir || documents.length === 0) return []
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR })
      return documents.map((d) => {
        const path = join(dir, freeName(dir, d.name))
        writeFileSync(path, Buffer.from(d.base64, 'base64'), { mode: PRIVATE_FILE })
        return path
      })
    } catch (err) {
      console.error('SessionManager: could not copy a document', err)
      return []
    }
  }

  private deliver(s: Session, content: UserContent): void {
    if (isEmpty(content)) return
    s.input.push(toUserMessage(content, this.keepCopies(s, content.documents ?? [])))
    this.setTurn(s, 'running')
  }

  private setTurn(s: Session, turn: TurnState, error?: string): void {
    s.turn = turn
    s.error = error
  }

  private async pump(s: Session): Promise<void> {
    try {
      for await (const msg of s.query) this.onMessage(s, msg)
      this.close(s, s.turn === 'error' ? 'error' : 'stopped', s.error)
    } catch (err) {
      // After a failed result the process exits too: the result says why.
      this.close(s, 'error', s.error ?? errorMessage(err))
    }
  }

  private onMessage(s: Session, msg: SDKMessage): void {
    if (s.closed) return
    if (msg.type === 'system' && msg.subtype === 'init' && msg.terminal_slash_commands) s.terminalCommands = new Set(msg.terminal_slash_commands)
    // A status carries it too: approving a plan leaves plan mode without any init.
    if (msg.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'status') && msg.permissionMode) s.mode = msg.permissionMode
    this.notify('message', { localId: s.localId, msg })
    if (msg.type === 'system' && msg.subtype === 'init' && !s.initialized) {
      s.initialized = true
      this.notify('commandsChanged', { localId: s.localId })
    }
    if (msg.type === 'result') {
      const turn = turnAfter(msg)
      this.setTurn(s, turn, turn === 'error' ? resultError(msg) : undefined)
    } else if (msg.type === 'stream_event' || msg.type === 'assistant') {
      // A message sent during a turn runs after that turn's result.
      this.setTurn(s, 'running')
    }
    this.syncState(s)
  }

  private askPermission(
    s: Session,
    toolName: string,
    input: Record<string, unknown>,
    o: CanUseToolOptions
  ): Promise<PermissionResult> {
    if (s.closed || o.signal.aborted) return Promise.resolve(WITHDRAWN)
    const { requestId, signal } = o
    // Other suggestion types would also switch the session's mode or widen its directories.
    const rules = o.suppressAlwaysAllowRule ? [] : (o.suggestions ?? []).filter((u) => u.type === 'addRules')
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.withdraw(s, requestId)
        this.syncState(s)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const request: PermissionRequest = {
        requestId,
        localId: s.localId,
        toolName,
        input,
        canAlways: rules.length > 0,
        toolUseID: o.toolUseID,
        description: o.description,
        decisionReason: o.decisionReason,
        blockedPath: o.blockedPath
      }
      s.pending.set(requestId, {
        request,
        rules,
        settle(result) {
          signal.removeEventListener('abort', onAbort)
          s.pending.delete(requestId)
          resolve(result)
        }
      })
      this.notify('permission', request)
      this.syncState(s)
    })
  }

  private withdraw(s: Session, requestId: string): void {
    s.pending.get(requestId)?.settle(WITHDRAWN)
    this.notify('permissionCancelled', { requestId, localId: s.localId })
  }

  private close(s: Session, state: 'stopped' | 'error', error?: string): void {
    if (s.closed) return
    s.closed = true
    this.sessions.delete(s.localId)
    s.input.close()
    try {
      s.query.close()
    } catch {
      // The process is already gone.
    }
    for (const requestId of [...s.pending.keys()]) this.withdraw(s, requestId)
    const copies = this.copiesDir(s.localId)
    if (copies) rmSync(copies, { recursive: true, force: true })
    this.notify('state', { localId: s.localId, state, sessionId: s.sessionId, error })
  }

  private syncState(s: Session): void {
    const state = currentState(s)
    if (s.closed || state === s.reported) return
    s.reported = state
    this.notify('state', { localId: s.localId, state, sessionId: s.sessionId, error: state === 'error' ? s.error : undefined })
  }

  /** A failing listener must not reach the message loop, which would end the session. */
  private notify<K extends keyof SessionEvents>(event: K, payload: SessionEvents[K]): void {
    try {
      ;(this.emit as (e: string, p: unknown) => boolean)(event, payload)
    } catch (err) {
      console.error(`SessionManager: "${event}" listener failed`, err)
    }
  }
}
