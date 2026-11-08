import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { WebContents } from 'electron'
import type { AppStore } from '../appStore'
import { git } from '../git/exec'
import { currentBranch } from '../git/switchBranch'
import { hasRef, mainWorktreeRoot } from '../git/worktrees'
import type { TicketFields, TicketPriority, TicketStatus } from '../../shared/tickets'
import type { TicketStore } from './store'
import { watchTickets } from './watch'

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/
const STATUSES: TicketStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']
const PRIORITIES: TicketPriority[] = ['urgent', 'high', 'medium', 'low', 'none']
const FIELD_KEYS: (keyof TicketFields)[] = ['title', 'description', 'status', 'priority', 'labels', 'subtasks', 'branch', 'worktree', 'base']
const MAX_LABEL = 50

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (what: string): Error => new Error(`${what} invalide`)

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad('Identifiant')
}

function optionalString(v: unknown, what: string): void {
  if (typeof v !== 'string') throw bad(what)
}

/** Checks the fields present in `raw`; unknown keys are refused. */
function parseFields(raw: unknown): Partial<TicketFields> {
  if (!isObject(raw)) throw bad('Ticket')
  for (const k of Object.keys(raw)) if (!(FIELD_KEYS as string[]).includes(k)) throw bad(`Champ ${k}`)
  const { title, description, status, priority, labels, subtasks, branch, worktree, base } = raw
  if (title !== undefined) optionalString(title, 'Titre')
  if (description !== undefined) optionalString(description, 'Description')
  if (status !== undefined && !STATUSES.includes(status as TicketStatus)) throw bad('Statut')
  if (priority !== undefined && !PRIORITIES.includes(priority as TicketPriority)) throw bad('Priorité')
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l === '' || l.length > MAX_LABEL)) throw bad('Étiquette')
  }
  if (subtasks !== undefined) {
    if (!Array.isArray(subtasks) || subtasks.some((s) => !isObject(s) || typeof s.title !== 'string' || typeof s.done !== 'boolean')) throw bad('Sous-tâche')
  }
  if (branch !== undefined) optionalString(branch, 'Branche')
  if (worktree !== undefined) optionalString(worktree, 'Worktree')
  if (base !== undefined) optionalString(base, 'Base')
  const out: Record<string, unknown> = {}
  for (const k of FIELD_KEYS) if (raw[k] !== undefined) out[k] = k === 'subtasks'
    ? (raw[k] as { title: string; done: boolean }[]).map((s) => ({ title: s.title, done: s.done }))
    : raw[k]
  return out as Partial<TicketFields>
}

function parseNewTicket(raw: unknown): TicketFields {
  const f = parseFields(raw)
  if (typeof f.title !== 'string' || f.title.trim() === '') throw bad('Titre')
  return { description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [], ...f, title: f.title }
}

/** The base remembered for the branch checked out at `cwd`; forgotten once its branch is gone. */
export async function branchBaseAt(store: AppStore, cwd: string): Promise<{ base: string } | { lost: string } | null> {
  const root = await mainWorktreeRoot(cwd)
  const branch = await currentBranch(cwd)
  if (branch === null) return null
  const base = store.branchBase(root, branch)
  if (base === undefined) return null
  if (await hasRef(root, `refs/heads/${base}`)) return { base }
  store.setBranchBase(root, branch, null)
  return { lost: base }
}

/** Names of the local branches of the repo. */
export async function localBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return out.split('\n').filter((b) => b !== '')
}

export function registerTicketIpc(
  broadcast: (event: string, payload?: unknown) => void, tickets: TicketStore, store: AppStore
): void {
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

  // One watched repo per window; a later call replaces it.
  const watched = new Map<number, () => void>()
  const hooked = new Set<number>()
  const unwatch = (id: number): void => { watched.get(id)?.(); watched.delete(id) }
  ipcMain.handle('tickets:watch', async (e, repo: unknown) => {
    assertPath(repo)
    const sender: WebContents = e.sender
    const root = await mainWorktreeRoot(repo)
    if (sender.isDestroyed()) return
    unwatch(sender.id)
    if (!hooked.has(sender.id)) {
      hooked.add(sender.id)
      sender.once('destroyed', () => { unwatch(sender.id); hooked.delete(sender.id) })
    }
    const stop = watchTickets(root, () => broadcast('tickets:changed', { repo: root }))
    watched.set(sender.id, stop)
  })

  ipcMain.handle('tickets:branchBase', (_e, cwd: unknown) => {
    assertPath(cwd)
    return branchBaseAt(store, cwd)
  })
}
