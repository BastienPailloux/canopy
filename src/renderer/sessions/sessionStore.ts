import type { ModelInfo, PermissionMode, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { create } from 'zustand'
import type { RepoTrust, SessionEvents } from '../../shared/api'
import { isRepoNotTrusted } from '../../shared/errors'
import type { PermissionRequest, SessionState, SessionSummary, UserContent } from '../../shared/types'
import { addNotice, addUser, emptyTranscript, reduceTranscript, settle, type Transcript, type UserImage } from './transcript'

export type TabState = SessionState | 'draft'

export interface SessionTab {
  id: string
  cwd: string
  /** The running process. Unset before the first start and once it ended. */
  localId?: string
  /** Unset until a session exists for this tab. */
  sessionId?: string
  title: string
  state: TabState
  error?: string
  transcript: Transcript
  /** What the composer holds. */
  draft: { text: string; images: UserImage[] }
  mode: PermissionMode
  model?: string
  commands: SlashCommand[]
  models: ModelInfo[]
}

interface TrustPrompt {
  trust: RepoTrust
  answer: (accepted: boolean) => void
}

interface SessionsState {
  tabs: Record<string, SessionTab>
  /** Selected tab per worktree. */
  active: Record<string, string>
  permissions: PermissionRequest[]
  /** Past sessions per worktree. */
  summaries: Record<string, SessionSummary[]>
  trustPrompt: TrustPrompt | null
}

export const NEW_SESSION_TITLE = 'Nouvelle session'

const RESUME_WARNING =
  "Session reprise. Si elle est encore ouverte dans une CLI, ferme-la d'abord : rien ne l'empêche d'écrire dans le même fichier, et la conversation se scinderait."

const TITLE_LENGTH = 40

export const useSessions = create<SessionsState>(() => ({
  tabs: {},
  active: {},
  permissions: [],
  summaries: {},
  trustPrompt: null
}))

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const tabOf = (id: string): SessionTab | undefined => useSessions.getState().tabs[id]
const tabsOf = (cwd: string): SessionTab[] => Object.values(useSessions.getState().tabs).filter((t) => t.cwd === cwd)
const tabOfProcess = (localId: string): SessionTab | undefined =>
  Object.values(useSessions.getState().tabs).find((t) => t.localId === localId)

const shortTitle = (c: UserContent): string => c.text.trim().split('\n')[0].slice(0, TITLE_LENGTH) || 'Image'

function patchTab(id: string, patch: Partial<SessionTab> | ((tab: SessionTab) => Partial<SessionTab>)): void {
  useSessions.setState((s) => {
    const tab = s.tabs[id]
    if (!tab) return s
    return { tabs: { ...s.tabs, [id]: { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } } }
  })
}

function addTab(cwd: string, fields: Partial<SessionTab>): string {
  const tab: SessionTab = {
    id: crypto.randomUUID(),
    cwd,
    title: NEW_SESSION_TITLE,
    state: 'draft',
    transcript: emptyTranscript(),
    draft: { text: '', images: [] },
    mode: 'default',
    commands: [],
    models: [],
    ...fields
  }
  useSessions.setState((s) => ({
    tabs: { ...s.tabs, [tab.id]: tab },
    active: { ...s.active, [cwd]: tab.id }
  }))
  return tab.id
}

export const selectTab = (cwd: string, id: string): void => {
  useSessions.setState((s) => ({ active: { ...s.active, [cwd]: id } }))
}

export const newTab = (cwd: string): string => addTab(cwd, {})

/** A worktree always has a tab to type in. */
export function ensureTab(cwd: string): void {
  const { active, tabs } = useSessions.getState()
  if (tabs[active[cwd]]) return
  const [first] = tabsOf(cwd)
  if (first) selectTab(cwd, first.id)
  else newTab(cwd)
}

/** The only way a session stops from the UI: switching view, worktree or repo never does. */
export function closeTab(id: string): void {
  const tab = tabOf(id)
  if (!tab) return
  if (tab.localId) void window.canopy.stopSession(tab.localId).catch(() => undefined)
  useSessions.setState((s) => {
    const { [id]: _closed, ...tabs } = s.tabs
    return { tabs, active: s.active[tab.cwd] === id ? omit(s.active, tab.cwd) : s.active }
  })
  ensureTab(tab.cwd)
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _key, ...rest } = record
  return rest
}

export function setDraftText(id: string, text: string): void {
  patchTab(id, (t) => ({ draft: { ...t.draft, text } }))
}

export function setDraftImages(id: string, change: (images: UserImage[]) => UserImage[]): void {
  patchTab(id, (t) => ({ draft: { ...t.draft, images: change(t.draft.images) } }))
}

function refreshCommands(tab: Pick<SessionTab, 'id' | 'localId'>): void {
  if (!tab.localId) return
  window.canopy.sessionCommands(tab.localId).then((commands) => patchTab(tab.id, { commands }), () => undefined)
}

function refreshModels(tab: Pick<SessionTab, 'id' | 'localId'>): void {
  if (!tab.localId) return
  window.canopy.sessionModels(tab.localId).then((models) => patchTab(tab.id, { models }), () => undefined)
}

/** Resolves true when `cwd`'s repo is trusted, asking first if needed. A refusal starts nothing. */
async function confirmTrust(cwd: string): Promise<boolean> {
  const trust = await window.canopy.repoTrust(cwd)
  if (trust.trusted) return true
  const accepted = await new Promise<boolean>((answer) => { useSessions.setState({ trustPrompt: { trust, answer } }) })
  useSessions.setState({ trustPrompt: null })
  if (accepted) await window.canopy.trustRepo(cwd, trust.configHash)
  return accepted
}

/** Warm-ups in progress, so that a message sent meanwhile does not start a second process. */
const warming = new Map<string, Promise<void>>()
/** Tabs whose draft is being sent. */
const submitting = new Set<string>()

/** A session that never got a reply has nothing on disk to resume. */
function isResumable(tab: SessionTab): boolean {
  return tab.sessionId !== undefined && tab.transcript.items.some((i) => i.kind === 'assistant' || i.kind === 'tool')
}

async function startProcess(tab: SessionTab, content: UserContent): Promise<void> {
  const localId = await window.canopy.startSession(tab.cwd, {
    content,
    mode: tab.mode,
    ...(tab.model ? { model: tab.model } : {}),
    ...(isResumable(tab) ? { resumeId: tab.sessionId } : {})
  })
  patchTab(tab.id, { localId })
  refreshCommands({ id: tab.id, localId })
  refreshModels({ id: tab.id, localId })
}

/**
 * Commands are only known from a running process: starts one without any message.
 * Asks for trust like a first message would, and a refusal just leaves the list empty.
 */
export function warmUp(id: string): void {
  const tab = tabOf(id)
  if (!tab || tab.localId || warming.has(id) || submitting.has(id)) return
  const run = (async (): Promise<void> => {
    try {
      if (await confirmTrust(tab.cwd)) await startProcess(tab, { text: '' })
    } catch (e) {
      patchTab(id, { error: startError(e) })
    }
  })().finally(() => warming.delete(id))
  warming.set(id, run)
}

function startError(e: unknown): string {
  return isRepoNotTrusted(e) ? "Ce dépôt n'est pas approuvé : la session n'a pas démarré." : errorText(e)
}

/** Sends the tab's draft, starting or resuming its session if needed. */
export async function submit(id: string): Promise<void> {
  if (submitting.has(id)) return
  submitting.add(id)
  try {
    await warming.get(id)
    await send(id)
  } finally {
    submitting.delete(id)
  }
}

async function send(id: string): Promise<void> {
  const tab = tabOf(id)
  if (!tab) return
  const { text, images } = tab.draft
  if (text.trim() === '' && images.length === 0) return
  const content: UserContent = { text: text.trim(), ...(images.length ? { images } : {}) }

  try {
    if (!tab.localId && !(await confirmTrust(tab.cwd))) return
  } catch (e) {
    patchTab(id, { error: startError(e) })
    return
  }

  patchTab(id, (t) => ({
    transcript: addUser(t.transcript, content),
    draft: { text: '', images: [] },
    state: 'running',
    error: undefined,
    title: t.title === NEW_SESSION_TITLE ? shortTitle(content) : t.title
  }))
  try {
    await deliver(tab, content)
  } catch (e) {
    patchTab(id, (t) => ({
      state: 'error',
      error: startError(e),
      // Nothing was sent: give the message back unless a new one was typed meanwhile.
      draft: t.draft.text === '' && t.draft.images.length === 0 ? tab.draft : t.draft
    }))
  }
}

async function deliver(tab: SessionTab, content: UserContent): Promise<void> {
  if (tab.localId) {
    try {
      await window.canopy.sendToSession(tab.localId, content)
      return
    } catch {
      // The process ended without this tab knowing yet: resume below.
      patchTab(tab.id, { localId: undefined })
    }
  }
  const current = tabOf(tab.id)
  if (current) await startProcess(current, content)
}

export function interrupt(id: string): void {
  const localId = tabOf(id)?.localId
  if (localId) void window.canopy.interruptSession(localId).catch(() => undefined)
}

export function setMode(id: string, mode: PermissionMode): void {
  patchTab(id, { mode })
  const localId = tabOf(id)?.localId
  if (localId) void window.canopy.setSessionMode(localId, mode).catch((e: unknown) => patchTab(id, { error: errorText(e) }))
}

export function setModel(id: string, model: string): void {
  patchTab(id, { model })
  const localId = tabOf(id)?.localId
  if (localId) void window.canopy.setSessionModel(localId, model).catch((e: unknown) => patchTab(id, { error: errorText(e) }))
}

export function answerPermission(requestId: string, decision: Parameters<typeof window.canopy.resolvePermission>[1]): void {
  useSessions.setState((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }))
  void window.canopy.resolvePermission(requestId, decision).catch(() => undefined)
}

async function loadHistory(cwd: string, s: SessionSummary): Promise<Transcript> {
  const messages = await window.canopy.sessionHistory(cwd, s.sessionId).catch(() => [])
  const transcript = messages.reduce(reduceTranscript, emptyTranscript())
  return s.live ? transcript : settle(transcript)
}

/** Opens a past session. Nothing runs until a message is sent. */
export async function openSession(cwd: string, s: SessionSummary): Promise<void> {
  const open = tabsOf(cwd).find((t) => t.sessionId === s.sessionId)
  if (open) {
    selectTab(cwd, open.id)
    return
  }
  const transcript = addNotice(await loadHistory(cwd, s), RESUME_WARNING)
  const untouched = tabsOf(cwd).filter((t) => t.state === 'draft' && !t.localId && t.draft.text === '' && t.draft.images.length === 0)
  addTab(cwd, { sessionId: s.sessionId, title: s.title || NEW_SESSION_TITLE, state: 'stopped', transcript })
  useSessions.setState((state) => ({
    tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => !untouched.some((t) => t.id === id)))
  }))
}

/** Gives a tab to a session running in the main process, after a reload. */
async function attach(cwd: string, s: SessionSummary): Promise<void> {
  const transcript = await loadHistory(cwd, s)
  // Resuming a live session sends nothing and only tells its localId.
  const localId = await window.canopy.startSession(cwd, { content: { text: '' }, resumeId: s.sessionId })
  if (tabOfProcess(localId)) return
  const id = addTab(cwd, { localId, sessionId: s.sessionId, title: s.title || NEW_SESSION_TITLE, state: s.state, transcript })
  refreshCommands({ id, localId })
  refreshModels({ id, localId })
}

/** Lists the worktree's sessions and reattaches the ones running without a tab. */
export async function syncWorktree(cwd: string): Promise<void> {
  const list = await window.canopy.listSessions(cwd).catch((): SessionSummary[] => [])
  useSessions.setState((s) => ({ summaries: { ...s.summaries, [cwd]: list } }))
  for (const s of list) {
    if (s.live && !tabsOf(cwd).some((t) => t.sessionId === s.sessionId)) await attach(cwd, s).catch(() => undefined)
  }
}

function onMessage({ localId, msg }: SessionEvents['message']): void {
  const tab = tabOfProcess(localId)
  if (!tab) return
  const mode = msg.type === 'system' && msg.subtype === 'init' ? msg.permissionMode : undefined
  patchTab(tab.id, (t) => ({
    transcript: reduceTranscript(t.transcript, msg),
    ...(mode && mode !== 'bypassPermissions' ? { mode } : {})
  }))
}

function onState({ localId, state, sessionId, error }: SessionEvents['state']): void {
  const tab = tabOfProcess(localId)
  if (!tab) return
  const ended = state === 'stopped' || state === 'error'
  patchTab(tab.id, (t) => ({
    state,
    sessionId: sessionId ?? t.sessionId,
    error: state === 'error' ? error : undefined,
    transcript: ended ? settle(t.transcript) : t.transcript,
    ...(state === 'stopped' ? { localId: undefined } : {})
  }))
}

function addPermission(request: PermissionRequest): void {
  useSessions.setState((s) => (s.permissions.some((p) => p.requestId === request.requestId)
    ? s
    : { permissions: [...s.permissions, request] }))
}

/** Subscribes to session events for the app's lifetime and shows requests a previous window left unanswered. */
export function connectSessions(): () => void {
  const on = <K extends keyof SessionEvents>(key: K, cb: (e: SessionEvents[K]) => void): (() => void) =>
    window.canopy.on(`session:${key}`, (payload) => cb(payload as SessionEvents[K]))
  const off = [
    on('message', onMessage),
    on('state', onState),
    on('permission', addPermission),
    on('permissionCancelled', ({ requestId }) => {
      useSessions.setState((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== requestId) }))
    }),
    on('commandsChanged', ({ localId }) => {
      const tab = tabOfProcess(localId)
      if (tab) refreshCommands(tab)
    })
  ]
  void window.canopy.pendingPermissions().then((list) => list.forEach(addPermission), () => undefined)
  return () => off.forEach((unsubscribe) => unsubscribe())
}
