import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { defaultPrefix, PREFIX_RE, sortTemplates, TEMPLATE_SLUG_RE, templateSlug } from '../../shared/tickets'
import type { TemplateFields, TemplateList, Ticket, TicketFields, TicketListEntry, TicketTemplate } from '../../shared/tickets'
import { git } from '../git/exec'
import { ensureExcluded, mainWorktreeRoot } from '../git/worktrees'
import { parseTicket, serializeTicket, unknownFields } from './format'
import { BUILTIN_TEMPLATES, parseTemplate, serializeTemplate } from './templates'

const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/
const EXCLUDE_ENTRY = '/.tickets/'

interface Config { prefix: string; next: number; defaultTemplate?: string }

const notFound = (id: string): Error => new Error(`Ticket introuvable : ${id}`)

/** Atomic write: tmp file then rename, like AppStore.save. */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, data, { flag: 'wx' })
  await rename(tmp, file)
}

/**
 * Create `file` only if it does not exist yet (exclusive create). Not through a hard link to a temp file:
 * macOS FSEvents then never reports the file's deletion, so a ticket removed outside Canopy would stay listed.
 */
async function writeNew(file: string, data: string): Promise<void> {
  try {
    await writeFile(file, data, { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Le fichier existe déjà : ${basename(file)}`)
    // The exclusive open succeeded (anything else is EEXIST), so a partial file is ours to remove.
    await rm(file, { force: true }).catch(() => undefined)
    throw e
  }
}

/** The error `writeNew` throws when the file already exists. */
const isAlreadyThere = (e: unknown): boolean => e instanceof Error && e.message.startsWith('Le fichier existe déjà')

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
    for (const p of [tickets, join(tickets, 'archive'), join(tickets, 'templates')]) {
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
        defaultTemplate: typeof c.defaultTemplate === 'string' ? c.defaultTemplate : undefined,
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

  /** Merge `changes` into the parsed config.json so keys we do not own (e.g. `defaultTemplate`) survive. */
  private async writeConfig(root: string, changes: Record<string, unknown>): Promise<void> {
    const file = join(this.dir(root), 'config.json')
    let current: Record<string, unknown> = {}
    try {
      const c = JSON.parse(await readFile(file, 'utf8'))
      if (c && typeof c === 'object' && !Array.isArray(c)) current = c
    } catch {
      // missing or corrupt: start over
    }
    await writeAtomic(file, JSON.stringify({ ...current, ...changes }, null, 2))
  }

  private async resolveConfig(root: string): Promise<Config> {
    const c = await this.readConfig(root)
    return {
      prefix: c.prefix ?? defaultPrefix(basename(root)),
      next: Math.max(c.next ?? 1, (await this.highest(root)) + 1),
    }
  }

  async config(repo: string): Promise<{ prefix: string; next: number }> {
    const root = await mainWorktreeRoot(repo)
    await this.guard(root)
    const { prefix, next } = await this.resolveConfig(root)
    return { prefix, next }
  }

  setPrefix(repo: string, prefix: string): Promise<void> {
    if (!PREFIX_RE.test(prefix)) return Promise.reject(new Error('Préfixe invalide (A–Z et chiffres, 10 caractères max)'))
    return this.withRoot(repo, '#config', async (root) => {
      await this.prepare(root)
      const c = await this.resolveConfig(root)
      await this.writeConfig(root, { prefix, next: c.next })
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

  create(repo: string, f: TicketFields): Promise<Ticket> {
    return this.withRoot(repo, '#config', async (root) => {
      await this.prepare(root)
      const c = await this.resolveConfig(root)
      const now = new Date().toISOString()
      const ticket: Ticket = { ...f, id: `${c.prefix}-${c.next}`, created: now, updated: now, archived: false }
      await writeNew(join(this.dir(root), `${ticket.id}.md`), serializeTicket(ticket))
      await this.writeConfig(root, { prefix: c.prefix, next: c.next + 1 })
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
      const next: Ticket = { ...current, updated: new Date().toISOString() }
      for (const [k, v] of Object.entries(changes)) {
        const rec = next as unknown as Record<string, unknown>
        if (v !== undefined) rec[k] = v
        else if (k === 'branch' || k === 'worktree' || k === 'base') delete rec[k]
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

  private templatesDir(root: string): string {
    return join(this.dir(root), 'templates')
  }

  private checkSlug(slug: string): void {
    if (!TEMPLATE_SLUG_RE.test(slug)) throw new Error(`Identifiant de modèle invalide : ${slug}`)
  }

  /** Built-ins are written only when the folder is absent, so a deleted template never comes back. */
  templates(repo: string): Promise<TemplateList> {
    return this.withRoot(repo, '#templates', async (root) => {
      await this.prepare(root)
      const dir = this.templatesDir(root)
      if (!(await lstat(dir).catch(() => undefined))) {
        await mkdir(dir, { recursive: true })
        for (const b of BUILTIN_TEMPLATES) {
          // Another writer seeded the same file first: theirs stays.
          await writeNew(join(dir, `${b.slug}.md`), serializeTemplate(b.fields)).catch((e: unknown) => { if (!isAlreadyThere(e)) throw e })
        }
        await this.guard(root)
      }
      const good: TicketTemplate[] = []
      const bad: TemplateList['entries'] = []
      for (const file of (await mdFiles(dir)).sort()) {
        // Editing, deleting and making it the default all go by slug: a file named otherwise could not be managed.
        if (!TEMPLATE_SLUG_RE.test(basename(file, '.md'))) {
          bad.push({ kind: 'unreadable', file, error: 'Nom de fichier invalide : minuscules, chiffres et tirets seulement' })
          continue
        }
        try {
          good.push(parseTemplate(await readFile(join(dir, file), 'utf8'), basename(file, '.md')))
        } catch (e) {
          bad.push({ kind: 'unreadable', file, error: e instanceof Error ? e.message : String(e) })
        }
      }
      const sorted = sortTemplates(good)
      const wanted = (await this.readConfig(root)).defaultTemplate
      const defaultSlug = sorted.find((t) => t.slug === wanted)?.slug ?? sorted[0]?.slug ?? null
      return { entries: [...sorted.map((template) => ({ kind: 'template' as const, template })), ...bad], defaultSlug }
    })
  }

  /** `null` creates a template (slug from the name, `-2`… on collision); otherwise rewrites it keeping its slug. */
  saveTemplate(repo: string, slug: string | null, f: TemplateFields): Promise<TicketTemplate> {
    if (slug !== null) this.checkSlug(slug)
    return this.withRoot(repo, '#templates', async (root) => {
      await this.prepare(root)
      const dir = this.templatesDir(root)
      await mkdir(dir, { recursive: true })
      await this.guard(root)
      const data = serializeTemplate(f)
      if (slug !== null) {
        const file = join(dir, `${slug}.md`)
        if (!(await lstat(file).catch(() => undefined))) throw new Error(`Modèle introuvable : ${slug}`)
        await writeAtomic(file, data)
        return { ...f, slug }
      }
      const base = templateSlug(f.name)
      for (let n = 1; ; n++) {
        const suffix = n === 1 ? '' : `-${n}`
        const candidate = n === 1 ? base : `${base.slice(0, 50 - suffix.length).replace(/-+$/, '')}${suffix}`
        try {
          await writeNew(join(dir, `${candidate}.md`), data)
          return { ...f, slug: candidate }
        } catch (e) {
          if (!isAlreadyThere(e)) throw e
        }
      }
    })
  }

  deleteTemplate(repo: string, slug: string): Promise<void> {
    this.checkSlug(slug)
    return this.withRoot(repo, '#templates', async (root) => {
      await this.guard(root)
      await rm(join(this.templatesDir(root), `${slug}.md`), { force: true })
    })
  }

  setDefaultTemplate(repo: string, slug: string): Promise<void> {
    this.checkSlug(slug)
    return this.withRoot(repo, '#config', async (root) => {
      await this.prepare(root)
      if (!(await lstat(join(this.templatesDir(root), `${slug}.md`)).catch(() => undefined))) throw new Error(`Modèle introuvable : ${slug}`)
      await this.writeConfig(root, { defaultTemplate: slug })
    })
  }
}
