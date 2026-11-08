import { isAbsolute } from 'node:path'
import type { LinearChange, LinearField, LinearLaunchRequest } from '../../shared/linear'
import { MAX_DESCRIPTION, MAX_LABEL, MAX_LABELS, MAX_TITLE, PRIORITIES, type LaunchTarget, type TicketPriority } from '../../shared/tickets'
import type { AppStore } from '../appStore'
import { mainWorktreeRoot } from '../git/worktrees'
import { clearSharedReads } from '../git/sharedReads'
import type { LaunchDeps } from '../tickets/launch'
import type { LinearClient } from './client'
import type { LinearEdits } from './edits'
import { launchLinear } from './launch'
import type { LinearSync } from './sync'

export const LINEAR_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/
export const PENDING_REFUSAL = "Des modifications Linear n'ont pas été envoyées."
const CHANGE_KEYS: LinearField[] = ['title', 'description', 'statusId', 'priority', 'labels', 'assigneeId']
/** Linear ids (status, team, user) are UUIDs; anything much longer is not one. */
const MAX_REF = 200
const MAX_ACK = 1000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (what: string): Error => new Error(`${what} invalide`)
const isRef = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_REF
const isRefArg = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.startsWith('-')

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !LINEAR_ID_RE.test(id)) throw bad('Identifiant Linear')
}

/** Checks a `LinearChange`; unknown keys and empty changes are refused. */
export function parseChange(raw: unknown): LinearChange {
  if (!isObject(raw)) throw bad('Modification')
  const keys = Object.keys(raw)
  if (keys.length === 0) throw bad('Modification')
  for (const k of keys) if (!(CHANGE_KEYS as string[]).includes(k)) throw bad(`Champ ${k}`)
  const { title, description, statusId, priority, labels, assigneeId } = raw
  const out: LinearChange = {}
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE) throw bad('Titre')
    out.title = title
  }
  if (description !== undefined) {
    if (!isObject(description) || typeof description.base !== 'string' || typeof description.text !== 'string' ||
      description.base.length > MAX_DESCRIPTION || description.text.length > MAX_DESCRIPTION) throw bad('Description')
    out.description = { base: description.base, text: description.text }
  }
  if (statusId !== undefined) {
    if (!isRef(statusId)) throw bad('Statut')
    out.statusId = statusId
  }
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority as TicketPriority)) throw bad('Priorité')
    out.priority = priority as TicketPriority
  }
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length > MAX_LABELS ||
      labels.some((l) => typeof l !== 'string' || l === '' || l.length > MAX_LABEL)) throw bad('Étiquette')
    out.labels = [...labels] as string[]
  }
  if (assigneeId !== undefined) {
    if (assigneeId !== null && !isRef(assigneeId)) throw bad('Assigné')
    out.assigneeId = assigneeId
  }
  return out
}

function parseFieldList(raw: unknown): LinearField[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((f) => !(CHANGE_KEYS as unknown[]).includes(f))) throw bad('Champ')
  return [...raw] as LinearField[]
}

function parseLaunch(raw: unknown): LinearLaunchRequest {
  if (!isObject(raw)) throw bad('Lancement')
  const { id, branch, target } = raw
  assertId(id)
  if (!isRefArg(branch)) throw bad('Branche')
  if (!isObject(target) || !isRefArg(target.base)) throw bad('Base')
  let t: LaunchTarget
  if (target.kind === 'new') t = { kind: 'new', base: target.base }
  else if (target.kind === 'existing') {
    if (typeof target.worktree !== 'string' || !isAbsolute(target.worktree)) throw bad('Worktree')
    t = { kind: 'existing', worktree: target.worktree, base: target.base }
  } else throw bad('Cible')
  return { id, branch, target: t }
}

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_ACK) throw bad('Identifiants')
  for (const id of raw) assertId(id)
  return [...raw] as string[]
}

/**
 * The launched Linear issues `LinearSync` keeps listed even when they would leave Bastien's list, app-wide: every
 * linked issue of every repo whose branch still exists locally. Cached, because `LinearSync` reads it synchronously;
 * `recompute` runs before every list, refresh and launch, and at startup. A root whose branches cannot be listed keeps
 * its previous answer (all its links the first time), so a git hiccup never turns into a false departure.
 */
export class LinkedIssues {
  private readonly byRoot = new Map<string, string[]>()

  constructor(
    private readonly store: Pick<AppStore, 'linearLinks' | 'linearLinkRoots'>,
    private readonly branches: (root: string) => Promise<string[]>,
  ) {}

  ids(): string[] {
    return [...new Set([...this.byRoot.values()].flat())]
  }

  async recompute(): Promise<void> {
    const roots = this.store.linearLinkRoots()
    const next = new Map<string, string[]>()
    await Promise.all(roots.map(async (root) => {
      const links = Object.entries(this.store.linearLinks(root))
      if (links.length === 0) return
      try {
        const existing = new Set(await this.branches(root))
        next.set(root, links.filter(([, l]) => existing.has(l.branch)).map(([id]) => id))
      } catch {
        next.set(root, this.byRoot.get(root) ?? links.map(([id]) => id))
      }
    }))
    this.byRoot.clear()
    for (const [root, ids] of next) this.byRoot.set(root, ids)
  }
}

type IpcClient = Pick<LinearClient, 'connection' | 'connect' | 'disconnect' | 'issue' | 'issueBrief' | 'teamOptions' | 'comment'>

export interface LinearIpcDeps {
  /** Registers `fn` for the IPC channel `name` (`ipcMain.handle` without the event). */
  handle: (name: string, fn: (...args: unknown[]) => unknown) => void
  client: IpcClient
  edits: Pick<LinearEdits, 'save' | 'pending' | 'discard' | 'retryAll' | 'onChange'>
  sync: Pick<LinearSync, 'state' | 'refresh' | 'ackDepartures' | 'clear' | 'onChange'>
  linked: Pick<LinkedIssues, 'recompute'>
  /** Where the links of launched issues are read. */
  store: Pick<AppStore, 'linearLinks'>
  /** What a launch needs. */
  launch: LaunchDeps
  /** To every window, through `canopy:event`. */
  broadcast: (event: string, payload: unknown) => void
  log?: (msg: string, e: unknown) => void
}

/** The `linear:*` channels. Every argument is checked here; `linear:changed` `{}` goes out on any sync, queue or connection change. */
export function registerLinearIpc(deps: LinearIpcDeps): void {
  const { client, edits, sync, linked, broadcast } = deps
  const log = deps.log ?? ((msg, e) => { console.error(msg, e) })
  const changed = (): void => { broadcast('linear:changed', {}) }
  sync.onChange(changed)
  edits.onChange(changed)

  // Any call can find the connection expired.
  let lastState = client.connection().state
  const checkConnection = (): void => {
    const now = client.connection().state
    if (now === lastState) return
    lastState = now
    changed()
  }
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    deps.handle(`linear:${name}`, async (...args) => {
      try { return await fn(...args) } finally { checkConnection() }
    })
  }
  const refreshLater = (): void => { void sync.refresh().catch((e: unknown) => { log('linear refresh failed', e) }) }

  handle('connection', () => client.connection())
  handle('connect', async () => {
    const conn = await client.connect()
    checkConnection()
    if (conn.state === 'connected') {
      void edits.retryAll().catch((e: unknown) => { log('linear retry failed', e) }).then(refreshLater)
    }
    return conn
  })
  handle('disconnect', async (force) => {
    if (edits.pending().length > 0 && force !== true) throw new Error(PENDING_REFUSAL)
    // Only once the tokens are gone: a failed disconnect keeps the queue.
    await client.disconnect()
    if (force === true) for (const p of edits.pending()) edits.discard(p.id)
    sync.clear()
  })
  // A failed read of the links never keeps the list from the renderer.
  const recompute = (): Promise<void> => linked.recompute().catch((e: unknown) => { log('linear links read failed', e) })
  handle('list', async (repo) => {
    assertPath(repo)
    await recompute()
    return sync.state()
  })
  handle('refresh', async (repo) => {
    assertPath(repo)
    await recompute()
    return sync.refresh()
  })
  handle('ackDepartures', (ids) => { sync.ackDepartures(parseIds(ids)) })
  handle('issue', (id) => { assertId(id); return client.issue(id) })
  handle('teamOptions', (teamId) => {
    if (!isRef(teamId)) throw bad('Équipe')
    return client.teamOptions(teamId)
  })
  handle('save', async (id, change) => {
    assertId(id)
    const r = await edits.save(id, parseChange(change))
    if (r.kind === 'sent') refreshLater()
    return r
  })
  handle('pending', () => edits.pending())
  handle('discard', (id, fields) => {
    assertId(id)
    edits.discard(id, parseFieldList(fields))
  })
  handle('comment', (id, body) => {
    assertId(id)
    if (typeof body !== 'string' || body.trim() === '' || body.length > MAX_DESCRIPTION) throw bad('Commentaire')
    return client.comment(id, body)
  })
  handle('launch', async (repo, req) => {
    assertPath(repo)
    const parsed = parseLaunch(req)
    try {
      const r = await launchLinear({ ...deps.launch, linear: client }, repo, parsed)
      await recompute()
      refreshLater()
      return r
    } finally {
      clearSharedReads()
    }
  })
  handle('links', async (repo) => {
    assertPath(repo)
    return deps.store.linearLinks(await mainWorktreeRoot(repo))
  })
}

/** At app start: reconnects with the stored tokens (never the browser), then resends the queue and refreshes. Never throws. */
export async function startLinear(deps: {
  client: Pick<LinearClient, 'resume'>
  linked: Pick<LinkedIssues, 'recompute'>
  edits: Pick<LinearEdits, 'retryAll'>
  sync: Pick<LinearSync, 'refresh'>
  broadcast: (event: string, payload: unknown) => void
  log?: (msg: string, e: unknown) => void
}): Promise<void> {
  const log = deps.log ?? ((msg, e) => { console.error(msg, e) })
  let state: string
  try {
    state = (await deps.client.resume()).state
  } catch (e) {
    log('linear resume failed', e)
    return
  }
  deps.broadcast('linear:changed', {})
  if (state !== 'connected') return
  try { await deps.edits.retryAll() } catch (e) { log('linear retry failed', e) }
  try { await deps.linked.recompute() } catch (e) { log('linear links read failed', e) }
  try { await deps.sync.refresh() } catch (e) { log('linear refresh failed', e) }
}
