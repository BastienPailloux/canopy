import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { WebContents } from 'electron'
import type { AppStore } from '../appStore'
import { git } from '../git/exec'
import { mainWorktreeRoot } from '../git/worktrees'
import { clearSharedReads } from '../git/sharedReads'
import { MAX_DESCRIPTION, MAX_LABEL, MAX_LABELS, MAX_SUBTASKS, MAX_TITLE, PRIORITIES, STATUSES, TICKET_ID_RE } from '../../shared/tickets'
import type { LaunchRequest, LaunchTarget, TicketFields, TicketPriority, TicketStatus } from '../../shared/tickets'
import { branchBaseAt } from './branchBase'
import { launchCandidates, launchTicket, type LaunchDeps } from './launch'
import type { TicketStore } from './store'
import { watchTickets } from './watch'

const FIELD_KEYS: (keyof TicketFields)[] = ['title', 'description', 'status', 'priority', 'labels', 'subtasks', 'branch', 'worktree', 'base', 'parent']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (what: string): Error => new Error(`${what} invalide`)

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !TICKET_ID_RE.test(id)) throw bad('Identifiant')
}


/** Checks the fields present in `raw`; unknown keys are refused. */
export function parseFields(raw: unknown): Partial<TicketFields> {
  if (!isObject(raw)) throw bad('Ticket')
  for (const k of Object.keys(raw)) if (!(FIELD_KEYS as string[]).includes(k)) throw bad(`Champ ${k}`)
  const { title, description, status, priority, labels, subtasks, branch, worktree, base, parent } = raw
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE)) throw bad('Titre')
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION)) throw bad('Description')
  if (status !== undefined && !STATUSES.includes(status as TicketStatus)) throw bad('Statut')
  if (priority !== undefined && !PRIORITIES.includes(priority as TicketPriority)) throw bad('Priorité')
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length > MAX_LABELS || labels.some((l) => typeof l !== 'string' || l === '' || l.length > MAX_LABEL)) throw bad('Étiquette')
  }
  if (subtasks !== undefined) {
    if (!Array.isArray(subtasks) || subtasks.length > MAX_SUBTASKS ||
      subtasks.some((s) => !isObject(s) || typeof s.title !== 'string' || s.title.length > MAX_TITLE || typeof s.done !== 'boolean')) throw bad('Sous-tâche')
  }
  if (branch !== undefined && typeof branch !== 'string') throw bad('Branche')
  if (worktree !== undefined && (typeof worktree !== 'string' || !isAbsolute(worktree))) throw bad('Worktree')
  if (base !== undefined && (typeof base !== 'string' || base === '' || base.startsWith('-'))) throw bad('Base')
  if (parent !== undefined && parent !== null && (typeof parent !== 'string' || !TICKET_ID_RE.test(parent))) throw bad('Parent')
  const out: Record<string, unknown> = {}
  for (const k of FIELD_KEYS) if (raw[k] !== undefined) out[k] = k === 'subtasks'
    ? (raw[k] as { title: string; done: boolean }[]).map((s) => ({ title: s.title, done: s.done }))
    : raw[k]
  // null from the renderer means "remove the parent": a key present with value undefined.
  if (parent === null) out.parent = undefined
  return out as Partial<TicketFields>
}

/** Like parseFields, with a required title and defaults for a new ticket. */
export function parseNewTicket(raw: unknown): TicketFields {
  const f = parseFields(raw)
  if (typeof f.title !== 'string' || f.title.trim() === '') throw bad('Titre')
  return { description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [], ...f, title: f.title }
}

const isRefArg = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.startsWith('-')

/** Checks a `LaunchTarget`: a base ref, and for an existing worktree its absolute path. */
export function parseLaunchTarget(target: unknown): LaunchTarget {
  if (!isObject(target) || !isRefArg(target.base)) throw bad('Base')
  if (target.kind === 'new') return { kind: 'new', base: target.base }
  if (target.kind === 'existing') {
    if (typeof target.worktree !== 'string' || !isAbsolute(target.worktree)) throw bad('Worktree')
    return { kind: 'existing', worktree: target.worktree, base: target.base }
  }
  throw bad('Cible')
}

function parseLaunch(raw: unknown): LaunchRequest {
  if (!isObject(raw)) throw bad('Lancement')
  const { id, branch, target, setInProgress } = raw
  assertId(id)
  if (!isRefArg(branch)) throw bad('Branche')
  if (typeof setInProgress !== 'boolean') throw bad('Statut')
  const t = parseLaunchTarget(target)
  return { id, branch, target: t, setInProgress }
}

/** Names of the local branches of the repo. */
export async function localBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return out.split('\n').filter((b) => b !== '')
}

/** What a launch reads from the live sessions and the repo trust. */
export type LaunchLive = Omit<LaunchDeps, 'tickets' | 'store'>

export function registerTicketIpc(tickets: TicketStore, store: AppStore, live: LaunchLive): void {
  const launchDeps: LaunchDeps = { tickets, store, ...live }
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`tickets:${name}`, (_e, ...args: unknown[]) => fn(...args))
  }
  handle('list', (repo) => { assertPath(repo); return tickets.list(repo) })
  handle('get', (repo, id) => { assertPath(repo); assertId(id); return tickets.get(repo, id) })
  handle('create', (repo, fields) => { assertPath(repo); return tickets.create(repo, parseNewTicket(fields)) })
  handle('patch', (repo, id, changes) => { assertPath(repo); assertId(id); return tickets.patch(repo, id, parseFields(changes)) })
  handle('duplicate', (repo, id) => { assertPath(repo); assertId(id); return tickets.duplicate(repo, id) })
  handle('archive', (repo, id) => { assertPath(repo); assertId(id); return tickets.archive(repo, id) })
  handle('config', (repo) => { assertPath(repo); return tickets.config(repo) })
  handle('setPrefix', (repo, prefix) => {
    assertPath(repo)
    if (typeof prefix !== 'string') throw bad('Préfixe')
    return tickets.setPrefix(repo, prefix)
  })
  handle('labels', (repo) => { assertPath(repo); return tickets.labels(repo) })
  handle('launchCandidates', (repo) => { assertPath(repo); return launchCandidates(launchDeps, repo) })
  handle('launch', async (repo, req) => {
    assertPath(repo)
    const parsed = parseLaunch(req)
    try {
      return await launchTicket(launchDeps, repo, parsed)
    } finally {
      clearSharedReads()
    }
  })

  // One watched repo per window; a later call replaces it. Events go to the owning window only.
  const watched = new Map<number, { root: string; stop: () => void }>()
  const latest = new Map<number, number>()
  const hooked = new Set<number>()
  const unwatch = (id: number): void => { watched.get(id)?.stop(); watched.delete(id) }
  ipcMain.handle('tickets:watch', async (e, repo: unknown) => {
    assertPath(repo)
    const sender: WebContents = e.sender
    const id = sender.id
    const seq = (latest.get(id) ?? 0) + 1
    latest.set(id, seq)
    const root = await mainWorktreeRoot(repo)
    // A newer call or a closed window won while git was answering.
    if (latest.get(id) !== seq || sender.isDestroyed()) return
    if (watched.get(id)?.root === root) return
    unwatch(id)
    if (!hooked.has(id)) {
      hooked.add(id)
      sender.once('destroyed', () => { unwatch(id); hooked.delete(id); latest.delete(id) })
    }
    const stop = watchTickets(root, () => {
      if (!sender.isDestroyed()) sender.send('canopy:event', 'tickets:changed', { repo: root })
    })
    watched.set(id, { root, stop })
  })

  ipcMain.handle('tickets:branchBase', (_e, cwd: unknown) => {
    assertPath(cwd)
    return branchBaseAt(store, cwd)
  })
}
