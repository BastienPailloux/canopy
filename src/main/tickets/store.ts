import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { defaultPrefix, PREFIX_RE } from '../../shared/tickets'
import type { Ticket, TicketFields, TicketListEntry } from '../../shared/tickets'
import { git } from '../git/exec'
import { ensureExcluded, mainWorktreeRoot } from '../git/worktrees'
import { parseTicket, serializeTicket, unknownFields } from './format'

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/
const EXCLUDE_ENTRY = '/.tickets/'

interface Config { prefix: string; next: number }

const notFound = (id: string): Error => new Error(`Ticket introuvable : ${id}`)

/** Atomic write: tmp file then rename, like AppStore.save. */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, data, { flag: 'wx' })
  await rename(tmp, file)
}

/** Create `file` only if it does not exist yet (link + unlink of a private temp file). */
async function writeNew(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, data, { flag: 'wx' })
  try {
    await link(tmp, file)
  } catch (e) {
    throw (e as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(`Le fichier existe déjà : ${basename(file)}`) : e
  } finally {
    await rm(tmp, { force: true })
  }
}

function checkId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Identifiant de ticket invalide : ${id}`)
}

async function mdFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => n.endsWith('.md'))
}

/** Tickets live in the main checkout's `.tickets/`, never in a worktree, and are kept out of git. */
export class TicketStore {
  private chains = new Map<string, Promise<unknown>>()

  /** Serialize operations sharing a key; a failure does not poison the chain. */
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
    return join(root, '.tickets')
  }

  /** Refuse a `.tickets` that is tracked, not a real directory, or resolves outside the repo. */
  private async guard(root: string): Promise<void> {
    const tickets = this.dir(root)
    for (const p of [tickets, join(tickets, 'archive')]) {
      const st = await lstat(p).catch(() => undefined)
      if (!st) continue
      if (!st.isDirectory()) throw new Error(`« ${p.slice(root.length + 1)} » n'est pas un vrai dossier : tickets ignorés`)
      const real = await realpath(p)
      const base = await realpath(root)
      if (real !== base && !real.startsWith(base + sep)) throw new Error(`« ${p.slice(root.length + 1)} » sort du dépôt : tickets ignorés`)
    }
    if ((await git(root, ['ls-files', '--', '.tickets'])).trim()) {
      throw new Error('« .tickets » est suivi par git : tickets ignorés')
    }
  }

  private async prepare(root: string): Promise<void> {
    await this.guard(root)
    await ensureExcluded(root, EXCLUDE_ENTRY)
    await mkdir(join(this.dir(root), 'archive'), { recursive: true })
    await this.guard(root)
  }

  private async readConfig(root: string): Promise<Partial<Config>> {
    try {
      const c = JSON.parse(await readFile(join(this.dir(root), 'config.json'), 'utf8'))
      return {
        prefix: typeof c.prefix === 'string' && PREFIX_RE.test(c.prefix) ? c.prefix : undefined,
        next: Number.isInteger(c.next) ? c.next : undefined,
      }
    } catch {
      return {}
    }
  }

  /** Highest ticket number in use, archived included, any prefix. */
  private async highest(root: string): Promise<number> {
    const d = this.dir(root)
    const files = [...(await mdFiles(d)), ...(await mdFiles(join(d, 'archive')))]
    let max = 0
    for (const f of files) {
      const m = /-(\d+)\.md$/.exec(f)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max
  }

  private async resolveConfig(root: string): Promise<Config> {
    const c = await this.readConfig(root)
    return {
      prefix: c.prefix ?? defaultPrefix(basename(root)),
      next: Math.max(c.next ?? 1, (await this.highest(root)) + 1),
    }
  }

  async config(repo: string): Promise<Config> {
    const root = await mainWorktreeRoot(repo)
    await this.guard(root)
    return this.resolveConfig(root)
  }

  setPrefix(repo: string, prefix: string): Promise<void> {
    if (!PREFIX_RE.test(prefix)) return Promise.reject(new Error('Préfixe invalide (A–Z et chiffres, 10 caractères max)'))
    return this.withRoot(repo, '#config', async (root) => {
      await this.prepare(root)
      const c = await this.resolveConfig(root)
      await writeAtomic(join(this.dir(root), 'config.json'), JSON.stringify({ prefix, next: c.next }, null, 2))
    })
  }

  private async withRoot<T>(repo: string, key: string, fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mainWorktreeRoot(repo)
    return this.serial(`${root}/${key}`, () => fn(root))
  }

  async list(repo: string): Promise<TicketListEntry[]> {
    const root = await mainWorktreeRoot(repo)
    await this.guard(root)
    const out: TicketListEntry[] = []
    for (const file of (await mdFiles(this.dir(root))).sort()) {
      try {
        const ticket = parseTicket(await readFile(join(this.dir(root), file), 'utf8'), basename(file, '.md'))
        out.push({ kind: 'ticket', ticket })
      } catch (e) {
        out.push({ kind: 'unreadable', file, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return out
  }

  async get(repo: string, id: string): Promise<Ticket> {
    checkId(id)
    const root = await mainWorktreeRoot(repo)
    await this.guard(root)
    const text = await readFile(join(this.dir(root), `${id}.md`), 'utf8').catch(() => null)
    if (text === null) throw notFound(id)
    return parseTicket(text, id)
  }

  /** The parent must be a live ticket and must not lead back to `id` (archived tickets are not in `.tickets/`). */
  private async checkParent(root: string, id: string | undefined, parent: string): Promise<void> {
    checkId(parent)
    if (parent === id) throw new Error('Un ticket ne peut pas être son propre parent')
    const read = (tid: string) => readFile(join(this.dir(root), `${tid}.md`), 'utf8').catch(() => null)
    if ((await read(parent)) === null) throw new Error(`Parent introuvable : ${parent}`)
    let cur: string | undefined = parent
    for (let i = 0; cur && i < 1000; i++) {
      if (cur === id) throw new Error(`Ce parent créerait une boucle : ${parent}`)
      const text = await read(cur)
      if (text === null) break
      try {
        cur = parseTicket(text, cur).parent
      } catch {
        break
      }
    }
  }

  /** Non-archived tickets whose parent is `id`, sorted by id. */
  async children(repo: string, id: string): Promise<Ticket[]> {
    checkId(id)
    const out: Ticket[] = []
    for (const e of await this.list(repo)) if (e.kind === 'ticket' && e.ticket.parent === id) out.push(e.ticket)
    return out
  }

  create(repo: string, f: TicketFields): Promise<Ticket> {
    return this.withRoot(repo, '#config', async (root) => {
      await this.prepare(root)
      if (f.parent) await this.checkParent(root, undefined, f.parent)
      const c = await this.resolveConfig(root)
      const now = new Date().toISOString()
      const ticket: Ticket = { ...f, id: `${c.prefix}-${c.next}`, created: now, updated: now, archived: false }
      await writeNew(join(this.dir(root), `${ticket.id}.md`), serializeTicket(ticket))
      await writeAtomic(join(this.dir(root), 'config.json'), JSON.stringify({ prefix: c.prefix, next: c.next + 1 }, null, 2))
      return ticket
    })
  }

  async patch(repo: string, id: string, changes: Partial<TicketFields>): Promise<Ticket> {
    checkId(id)
    return this.withRoot(repo, id, async (root) => {
      await this.prepare(root)
      const file = join(this.dir(root), `${id}.md`)
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) throw notFound(id)
      const current = parseTicket(text, id)
      if (changes.parent) await this.checkParent(root, id, changes.parent)
      const next: Ticket = { ...current, updated: new Date().toISOString() }
      for (const [k, v] of Object.entries(changes)) {
        const rec = next as unknown as Record<string, unknown>
        if (v !== undefined) rec[k] = v
        else if (k === 'branch' || k === 'worktree' || k === 'base' || k === 'parent') delete rec[k]
      }
      await writeAtomic(file, serializeTicket(next, unknownFields(text)))
      return next
    })
  }

  async duplicate(repo: string, id: string): Promise<Ticket> {
    checkId(id)
    const src = await this.get(repo, id)
    return this.create(repo, {
      title: `${src.title} (copie)`,
      description: src.description,
      status: 'backlog',
      priority: src.priority,
      labels: src.labels,
      subtasks: src.subtasks.map((s) => ({ ...s })),
    })
  }

  async archive(repo: string, id: string): Promise<void> {
    checkId(id)
    return this.withRoot(repo, id, async (root) => {
      await this.prepare(root)
      const file = join(this.dir(root), `${id}.md`)
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) throw notFound(id)
      const t = { ...parseTicket(text, id), archived: true, updated: new Date().toISOString() }
      const dest = join(this.dir(root), 'archive', `${id}.md`)
      await writeNew(dest, serializeTicket(t, unknownFields(text)))
      await rm(file)
    })
  }

  async labels(repo: string): Promise<string[]> {
    const set = new Set<string>()
    for (const e of await this.list(repo)) if (e.kind === 'ticket') e.ticket.labels.forEach((l) => set.add(l))
    return [...set].sort()
  }
}
