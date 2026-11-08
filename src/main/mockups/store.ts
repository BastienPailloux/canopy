import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { MAX_MOCKUP_TITLE, MOCKUP_ID_RE, MOCKUP_KINDS, MOCKUP_STATUSES, parseArtifactUrl } from '../../shared/mockups'
import type { Mockup, MockupChanges, MockupFields, MockupKind, MockupList, MockupStatus } from '../../shared/mockups'
import { TICKET_ID_RE as TICKET_RE } from '../../shared/tickets'
import { git } from '../git/exec'
import { ensureExcluded, mainWorktreeRoot } from '../git/worktrees'

const DIR = '.mockups'
const FILE = 'mockups.json'
const EXCLUDE_ENTRY = '/.mockups/'
const DEFAULT_TITLE = 'Maquette sans titre'

type Raw = Record<string, unknown>

/** The registry as read: the raw objects, kept to preserve unknown keys on rewrite, and their checked view. */
interface Registry { doc: Raw; entries: Raw[]; mockups: Mockup[] }

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

const notFound = (id: string): Error => new Error(`Maquette introuvable : ${id}`)

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, data, { flag: 'wx' })
  await rename(tmp, file)
}

/** Checks one entry of the file; throws with what is wrong. */
function parseEntry(raw: unknown, index: number): Mockup {
  const where = `maquette ${index + 1}`
  if (!isObject(raw)) throw new Error(`${where} : objet attendu`)
  const { id, url, title, kind, status, ticket, titleSet, added, updated } = raw
  if (typeof id !== 'string' || !MOCKUP_ID_RE.test(id)) throw new Error(`${where} : identifiant invalide`)
  const parsed = typeof url === 'string' ? parseArtifactUrl(url) : null
  if (!parsed || parsed.id !== id) throw new Error(`${where} : lien invalide`)
  if (typeof title !== 'string') throw new Error(`${where} : titre invalide`)
  if (!MOCKUP_KINDS.includes(kind as MockupKind)) throw new Error(`${where} : gabarit invalide`)
  if (!MOCKUP_STATUSES.includes(status as MockupStatus)) throw new Error(`${where} : statut invalide`)
  if (ticket !== undefined && (typeof ticket !== 'string' || !TICKET_RE.test(ticket))) throw new Error(`${where} : ticket invalide`)
  if (titleSet !== undefined && typeof titleSet !== 'boolean') throw new Error(`${where} : titleSet invalide`)
  if (typeof added !== 'string' || typeof updated !== 'string') throw new Error(`${where} : dates invalides`)
  return {
    id, url: parsed.url, title, kind: kind as MockupKind, status: status as MockupStatus,
    ...(ticket !== undefined ? { ticket } : {}), ...(titleSet !== undefined ? { titleSet } : {}), added, updated,
  }
}

/** Parses the file's text; throws with the reason when it cannot be trusted. */
export function parseRegistry(text: string): Registry {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`JSON invalide (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!isObject(doc)) throw new Error('objet attendu')
  if (doc.version !== 1) throw new Error(`version inconnue : ${JSON.stringify(doc.version)}`)
  if (!Array.isArray(doc.mockups)) throw new Error('liste « mockups » manquante')
  const entries = doc.mockups as Raw[]
  return { doc, entries, mockups: entries.map(parseEntry) }
}

function serializeRegistry(r: Registry): string {
  return `${JSON.stringify({ ...r.doc, version: 1, mockups: r.entries }, null, 2)}\n`
}

/** Applies `changes` to a raw entry; a title typed by the user sets `titleSet` unless it is given. */
function applyChanges(entry: Raw, changes: MockupChanges): void {
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || k === 'auto') continue
    if (k === 'ticket' && v === null) delete entry.ticket
    else entry[k] = k === 'title' ? (v as string).trim() : v
  }
  if (changes.title !== undefined && changes.titleSet === undefined) entry.titleSet = true
}

/** Mockups live in the main checkout's `.mockups/mockups.json`, never in a worktree, and are kept out of git. */
export class MockupStore {
  private chains = new Map<string, Promise<unknown>>()

  /** Serialize operations on one registry; a failure does not poison the chain. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return run
  }

  private dir(root: string): string {
    return join(root, DIR)
  }

  /** Refuse a `.mockups` that is tracked, not a real directory, or resolves outside the repo. */
  private async guard(root: string): Promise<void> {
    const dir = this.dir(root)
    const st = await lstat(dir).catch(() => undefined)
    if (st) {
      if (!st.isDirectory()) throw new Error(`« ${DIR} » n'est pas un vrai dossier : maquettes ignorées`)
      const real = await realpath(dir)
      const base = await realpath(root)
      if (real !== base && !real.startsWith(base + sep)) throw new Error(`« ${DIR} » sort du dépôt : maquettes ignorées`)
      const file = await lstat(join(dir, FILE)).catch(() => undefined)
      if (file && !file.isFile()) throw new Error(`« ${DIR}/${FILE} » n'est pas un vrai fichier : maquettes ignorées`)
    }
    if ((await git(root, ['ls-files', '--', DIR])).trim()) {
      throw new Error(`« ${DIR} » est suivi par git : maquettes ignorées`)
    }
  }

  private async prepare(root: string): Promise<void> {
    await this.guard(root)
    await ensureExcluded(root, EXCLUDE_ENTRY)
    await mkdir(this.dir(root), { recursive: true })
    await this.guard(root)
  }

  /** Null: no registry yet. Throws when the file cannot be read or trusted. */
  private async read(root: string): Promise<Registry | null> {
    const text = await readFile(join(this.dir(root), FILE), 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    return text === null ? null : parseRegistry(text)
  }

  /** Read for a write: an unreadable file stops the write, and is left as it is. */
  private async readForWrite(root: string): Promise<Registry> {
    try {
      return (await this.read(root)) ?? { doc: { version: 1 }, entries: [], mockups: [] }
    } catch (e) {
      throw new Error(`${FILE} illisible : ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private write(root: string, r: Registry): Promise<void> {
    return writeAtomic(join(this.dir(root), FILE), serializeRegistry(r))
  }

  /** Read, change and write the registry of the repo, serialized; `fn` returns what to answer, and whether to write. */
  private async update<T>(repo: string, fn: (r: Registry) => { value: T; write: boolean }): Promise<T> {
    const root = await mainWorktreeRoot(repo)
    return this.serial(root, async () => {
      await this.prepare(root)
      const r = await this.readForWrite(root)
      const { value, write } = fn(r)
      if (write) await this.write(root, r)
      return value
    })
  }

  async list(repo: string): Promise<MockupList> {
    const root = await mainWorktreeRoot(repo)
    await this.guard(root)
    try {
      return { kind: 'ok', mockups: (await this.read(root))?.mockups ?? [] }
    } catch (e) {
      return { kind: 'unreadable', error: `${FILE} illisible : ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** Registers the mockup at `url`. Already there: returns it, linked to `fields.ticket` if it had no ticket. */
  add(repo: string, url: string, fields: Partial<MockupFields> = {}): Promise<Mockup> {
    const parsed = parseArtifactUrl(url)
    if (!parsed) return Promise.reject(new Error('Lien de maquette invalide'))
    return this.update(repo, (r) => {
      const i = r.mockups.findIndex((m) => m.id === parsed.id)
      const now = new Date().toISOString()
      if (i >= 0) {
        if (fields.ticket === undefined || r.mockups[i].ticket !== undefined) return { value: r.mockups[i], write: false }
        r.entries[i].ticket = fields.ticket
        r.entries[i].updated = now
        return { value: parseEntry(r.entries[i], i), write: true }
      }
      const entry: Raw = { id: parsed.id, url: parsed.url, title: DEFAULT_TITLE, kind: 'web', status: 'todo', added: now, updated: now }
      applyChanges(entry, fields)
      r.entries.push(entry)
      return { value: parseEntry(entry, r.entries.length - 1), write: true }
    })
  }

  patch(repo: string, id: string, changes: MockupChanges): Promise<Mockup> {
    if (!MOCKUP_ID_RE.test(id)) return Promise.reject(new Error(`Identifiant de maquette invalide : ${id}`))
    if (changes.title !== undefined && (changes.title.trim() === '' || changes.title.length > MAX_MOCKUP_TITLE)) {
      return Promise.reject(new Error('Titre invalide'))
    }
    return this.update(repo, (r) => {
      const i = r.mockups.findIndex((m) => m.id === id)
      if (i < 0) throw notFound(id)
      // A page title arriving after the user renamed the mockup: the user's name stays.
      if (changes.auto && r.mockups[i].titleSet === true) {
        const { title: _title, titleSet: _titleSet, auto: _auto, ...rest } = changes
        if (Object.values(rest).every((v) => v === undefined)) return { value: r.mockups[i], write: false }
        changes = rest
      }
      applyChanges(r.entries[i], changes)
      r.entries[i].updated = new Date().toISOString()
      return { value: parseEntry(r.entries[i], i), write: true }
    })
  }

  /** Forgets the mockup (it stays on claude.ai). Absent: nothing to do. */
  remove(repo: string, id: string): Promise<void> {
    if (!MOCKUP_ID_RE.test(id)) return Promise.reject(new Error(`Identifiant de maquette invalide : ${id}`))
    return this.update(repo, (r) => {
      const i = r.mockups.findIndex((m) => m.id === id)
      if (i < 0) return { value: undefined, write: false }
      r.entries.splice(i, 1)
      r.mockups.splice(i, 1)
      return { value: undefined, write: true }
    })
  }
}
