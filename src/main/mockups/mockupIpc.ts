import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { WebContents } from 'electron'
import { MAX_MOCKUP_TITLE, MOCKUP_ID_RE, MOCKUP_KINDS, MOCKUP_STATUSES, parseArtifactUrl } from '../../shared/mockups'
import type { MockupChanges, MockupKind, MockupStatus } from '../../shared/mockups'
import { mainWorktreeRoot } from '../git/worktrees'
import { watchFolder } from '../tickets/watch'
import type { MockupStore } from './store'

const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/
const FIELD_KEYS: (keyof MockupChanges)[] = ['title', 'kind', 'status', 'ticket', 'titleSet']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (what: string): Error => new Error(`${what} invalide`)

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !MOCKUP_ID_RE.test(id)) throw bad('Identifiant')
}

function assertUrl(url: unknown): asserts url is string {
  if (typeof url !== 'string' || !parseArtifactUrl(url)) throw bad('Lien de maquette')
}

/** Checks the fields present in `raw`; unknown keys are refused. */
export function parseMockupChanges(raw: unknown): MockupChanges {
  if (!isObject(raw)) throw bad('Maquette')
  for (const k of Object.keys(raw)) if (!(FIELD_KEYS as string[]).includes(k)) throw bad(`Champ ${k}`)
  const { title, kind, status, ticket, titleSet } = raw
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > MAX_MOCKUP_TITLE)) throw bad('Titre')
  if (kind !== undefined && !MOCKUP_KINDS.includes(kind as MockupKind)) throw bad('Gabarit')
  if (status !== undefined && !MOCKUP_STATUSES.includes(status as MockupStatus)) throw bad('Statut')
  if (ticket !== undefined && ticket !== null && (typeof ticket !== 'string' || !TICKET_RE.test(ticket))) throw bad('Ticket')
  if (titleSet !== undefined && typeof titleSet !== 'boolean') throw bad('titleSet')
  const out: Record<string, unknown> = {}
  for (const k of FIELD_KEYS) if (raw[k] !== undefined) out[k] = raw[k]
  return out as MockupChanges
}

export function registerMockupIpc(mockups: MockupStore): void {
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`mockups:${name}`, (_e, ...args: unknown[]) => fn(...args))
  }
  handle('list', (repo) => { assertPath(repo); return mockups.list(repo) })
  handle('add', (repo, url, fields) => {
    assertPath(repo)
    assertUrl(url)
    const { ticket, ...rest } = fields === undefined ? {} : parseMockupChanges(fields)
    return mockups.add(repo, url, { ...rest, ...(ticket ? { ticket } : {}) })
  })
  handle('patch', (repo, id, changes) => { assertPath(repo); assertId(id); return mockups.patch(repo, id, parseMockupChanges(changes)) })
  handle('remove', (repo, id) => { assertPath(repo); assertId(id); return mockups.remove(repo, id) })

  // One watched repo per window; a later call replaces it. Events go to the owning window only.
  const watched = new Map<number, { root: string; stop: () => void }>()
  const latest = new Map<number, number>()
  const hooked = new Set<number>()
  const unwatch = (id: number): void => { watched.get(id)?.stop(); watched.delete(id) }
  ipcMain.handle('mockups:watch', async (e, repo: unknown) => {
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
    const stop = watchFolder(root, '.mockups', () => {
      if (!sender.isDestroyed()) sender.send('canopy:event', 'mockups:changed', { repo: root })
    })
    watched.set(id, { root, stop })
  })
}
