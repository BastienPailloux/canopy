import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TicketStore } from '../../../src/main/tickets/store'
import type { TicketFields } from '../../../src/shared/tickets'
import { createRepo, type TestRepo } from '../../helpers/repo'

const fields = (over: Partial<TicketFields> = {}): TicketFields => ({
  title: 'Un ticket',
  description: 'desc',
  status: 'backlog',
  priority: 'none',
  labels: [],
  subtasks: [],
  ...over,
})

let repo: TestRepo
let store: TicketStore
beforeEach(async () => {
  repo = await createRepo({ dirName: 'canopy' })
  store = new TicketStore()
})
afterEach(() => repo.cleanup())

const dir = () => join(repo.path, '.tickets')

describe('TicketStore', () => {
  it('create writes .tickets/CAN-1.md in the main checkout', async () => {
    const wt = join(repo.path, '..', 'wt')
    execFileSync('git', ['worktree', 'add', '-b', 'x', wt], { cwd: repo.path, stdio: 'pipe' })
    const t = await store.create(wt, fields())
    expect(t.id).toBe('CAN-1')
    expect(existsSync(join(dir(), 'CAN-1.md'))).toBe(true)
    expect(existsSync(join(wt, '.tickets'))).toBe(false)
  })

  it('excludes .tickets from git', async () => {
    await store.create(repo.path, fields())
    await store.create(repo.path, fields())
    const ex = await readFile(join(repo.path, '.git/info/exclude'), 'utf8')
    expect(ex.split('\n').filter((l) => l.trim() === '/.tickets/')).toHaveLength(1)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo.path }).toString()).toBe('')
  })

  it('ids increment across prefix changes', async () => {
    expect((await store.create(repo.path, fields())).id).toBe('CAN-1')
    await store.setPrefix(repo.path, 'DPP')
    expect((await store.create(repo.path, fields())).id).toBe('DPP-2')
    await expect(store.setPrefix(repo.path, 'bad')).rejects.toThrow()
  })

  it('next id survives a lost config', async () => {
    for (let i = 0; i < 3; i++) await store.create(repo.path, fields())
    await store.archive(repo.path, 'CAN-3')
    await rm(join(dir(), 'config.json'))
    expect((await new TicketStore().create(repo.path, fields())).id).toBe('CAN-4')
  })

  it('patch keeps fields changed on disk', async () => {
    await store.create(repo.path, fields())
    const f = join(dir(), 'CAN-1.md')
    await writeFile(f, (await readFile(f, 'utf8')).replace('priority: none', 'priority: low'))
    const t = await store.patch(repo.path, 'CAN-1', { title: 'New' })
    expect(t.title).toBe('New')
    expect(t.priority).toBe('low')
  })

  it('patch keeps unknown front-matter keys', async () => {
    await store.create(repo.path, fields())
    const f = join(dir(), 'CAN-1.md')
    await writeFile(f, (await readFile(f, 'utf8')).replace('status:', 'custom: hello\nstatus:'))
    await store.patch(repo.path, 'CAN-1', { title: 'New' })
    expect(await readFile(f, 'utf8')).toContain('custom: hello')
  })

  it('concurrent patches on one ticket both land', async () => {
    await store.create(repo.path, fields())
    await Promise.all([
      store.patch(repo.path, 'CAN-1', { title: 'T2' }),
      store.patch(repo.path, 'CAN-1', { labels: ['a'] }),
    ])
    const t = await store.get(repo.path, 'CAN-1')
    expect(t.title).toBe('T2')
    expect(t.labels).toEqual(['a'])
  })

  it('unreadable files are reported, not rewritten', async () => {
    await mkdir(dir(), { recursive: true })
    const bad = '---\ntitle: [unclosed\n---\n'
    const f = join(dir(), 'BAD-1.md')
    await writeFile(f, bad)
    const list = await store.list(repo.path)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'unreadable', file: 'BAD-1.md' })
    await expect(store.patch(repo.path, 'BAD-1', { title: 'x' })).rejects.toThrow()
    await expect(store.archive(repo.path, 'BAD-1')).rejects.toThrow()
    expect(await readFile(f, 'utf8')).toBe(bad)
  })

  it('refuses a symlinked .tickets', async () => {
    const target = await mkdtemp(join(tmpdir(), 'canopy-link-'))
    await symlink(target, dir())
    await expect(store.create(repo.path, fields())).rejects.toThrow(/vrai dossier/)
    await expect(store.list(repo.path)).rejects.toThrow(/vrai dossier/)
    expect(await readdir(target)).toEqual([])
  })

  it('refuses a symlinked archive', async () => {
    await store.create(repo.path, fields())
    const target = await mkdtemp(join(tmpdir(), 'canopy-link-'))
    await rm(join(dir(), 'archive'), { recursive: true })
    await symlink(target, join(dir(), 'archive'))
    await expect(store.archive(repo.path, 'CAN-1')).rejects.toThrow(/vrai dossier/)
    expect(await readdir(target)).toEqual([])
    expect(existsSync(join(dir(), 'CAN-1.md'))).toBe(true)
  })

  it('refuses a tracked .tickets', async () => {
    await repo.commit('.tickets/CAN-1.md', 'x')
    await expect(store.create(repo.path, fields())).rejects.toThrow(/suivi par git/)
  })

  it('rejects malformed ids', async () => {
    for (const id of ['../../x', 'can-1', 'CAN-1/../x', 'CAN']) {
      await expect(store.get(repo.path, id)).rejects.toThrow(/invalide/)
      await expect(store.patch(repo.path, id, {})).rejects.toThrow(/invalide/)
      await expect(store.archive(repo.path, id)).rejects.toThrow(/invalide/)
      await expect(store.duplicate(repo.path, id)).rejects.toThrow(/invalide/)
    }
  })

  it('patch and archive also exclude .tickets from git', async () => {
    await store.create(repo.path, fields())
    await writeFile(join(repo.path, '.git/info/exclude'), '')
    await store.patch(repo.path, 'CAN-1', { title: 'x' })
    expect(await readFile(join(repo.path, '.git/info/exclude'), 'utf8')).toContain('/.tickets/')
    await writeFile(join(repo.path, '.git/info/exclude'), '')
    await store.archive(repo.path, 'CAN-1')
    expect(await readFile(join(repo.path, '.git/info/exclude'), 'utf8')).toContain('/.tickets/')
  })

  it('patch ignores undefined for required keys and clears optional ones', async () => {
    await store.create(repo.path, fields({ branch: 'feat/a' }))
    const t = await store.patch(repo.path, 'CAN-1', { title: undefined, branch: undefined })
    expect(t.title).toBe('Un ticket')
    expect(t.branch).toBeUndefined()
  })

  it('archive refuses to overwrite an archived ticket', async () => {
    await store.create(repo.path, fields())
    await writeFile(join(dir(), 'archive', 'CAN-1.md'), 'keep')
    await expect(store.archive(repo.path, 'CAN-1')).rejects.toThrow(/existe déjà/)
    expect(await readFile(join(dir(), 'archive', 'CAN-1.md'), 'utf8')).toBe('keep')
  })

  it('archive moves the file and hides it from list', async () => {
    await store.create(repo.path, fields())
    await store.archive(repo.path, 'CAN-1')
    expect(await store.list(repo.path)).toEqual([])
    expect(existsSync(join(dir(), 'CAN-1.md'))).toBe(false)
    expect(await readFile(join(dir(), 'archive', 'CAN-1.md'), 'utf8')).toContain('archived: true')
  })

  it('patch and archive reject unknown ids in French', async () => {
    await expect(store.patch(repo.path, 'CAN-9', { title: 'x' })).rejects.toThrow(/introuvable/)
    await expect(store.archive(repo.path, 'CAN-9')).rejects.toThrow(/introuvable/)
  })

  it('duplicate, labels and config', async () => {
    await store.create(repo.path, fields({ title: 'A', status: 'done', labels: ['z', 'b'], branch: 'feat/a' }))
    const d = await store.duplicate(repo.path, 'CAN-1')
    expect(d).toMatchObject({ id: 'CAN-2', title: 'A (copie)', status: 'backlog' })
    expect(d.branch).toBeUndefined()
    expect(await store.labels(repo.path)).toEqual(['b', 'z'])
    expect(await store.config(repo.path)).toEqual({ prefix: 'CAN', next: 3 })
  })

  it('list on a repo without .tickets is empty and creates nothing', async () => {
    expect(await store.list(repo.path)).toEqual([])
    expect(await store.config(repo.path)).toMatchObject({ prefix: 'CAN' })
    expect(existsSync(dir())).toBe(false)
    expect(await readdir(repo.path)).not.toContain('.tickets')
  })
  it('a copied file with a stale id: lists under its file name and patches only itself', async () => {
    const a = await store.create(repo.path, fields({ title: 'Original' }))
    const text = await readFile(join(dir(), `${a.id}.md`), 'utf8')
    await writeFile(join(dir(), 'CAN-4.md'), text)
    const ids = (await store.list(repo.path)).map((e) => (e.kind === 'ticket' ? e.ticket.id : e.file))
    expect(ids).toEqual(['CAN-1', 'CAN-4'])
    const p = await store.patch(repo.path, 'CAN-4', { title: 'Copie' })
    expect(p.id).toBe('CAN-4')
    expect(await readFile(join(dir(), 'CAN-4.md'), 'utf8')).toMatch(/^id: CAN-4$/m)
    expect((await store.get(repo.path, 'CAN-1')).title).toBe('Original')
  })

  describe('parent', () => {
    it('creates a sub-ticket', async () => {
      const a = await store.create(repo.path, fields())
      const b = await store.create(repo.path, fields({ parent: a.id }))
      expect((await store.get(repo.path, b.id)).parent).toBe(a.id)
      expect((await store.children(repo.path, a.id)).map((t) => t.id)).toEqual([b.id])
    })

    it('refuses a missing parent', async () => {
      await expect(store.create(repo.path, fields({ parent: 'CAN-99' }))).rejects.toThrow('Parent introuvable : CAN-99')
    })

    it('refuses itself as parent', async () => {
      const a = await store.create(repo.path, fields())
      await expect(store.patch(repo.path, a.id, { parent: a.id })).rejects.toThrow('Un ticket ne peut pas être son propre parent')
    })

    it('refuses a cycle', async () => {
      const a = await store.create(repo.path, fields())
      const b = await store.create(repo.path, fields({ parent: a.id }))
      await expect(store.patch(repo.path, a.id, { parent: b.id })).rejects.toThrow(`Ce parent créerait une boucle : ${b.id}`)
    })

    it('refuses an archived parent', async () => {
      const a = await store.create(repo.path, fields())
      await store.archive(repo.path, a.id)
      await expect(store.create(repo.path, fields({ parent: a.id }))).rejects.toThrow(`Parent introuvable : ${a.id}`)
    })

    it('removes the parent', async () => {
      const a = await store.create(repo.path, fields())
      const b = await store.create(repo.path, fields({ parent: a.id }))
      await store.patch(repo.path, b.id, { parent: undefined })
      expect((await store.get(repo.path, b.id)).parent).toBeUndefined()
      expect(await store.children(repo.path, a.id)).toEqual([])
    })

    it('keeps children of a missing parent readable', async () => {
      await store.create(repo.path, fields())
      await writeFile(join(dir(), 'CAN-2.md'), '---\nid: CAN-2\ntitle: Orphelin\nstatus: todo\npriority: none\nlabels: []\ncreated: 2026-11-08T10:12:00Z\nupdated: 2026-11-08T10:12:00Z\nparent: CAN-999\n---\n')
      expect((await store.get(repo.path, 'CAN-2')).parent).toBe('CAN-999')
      const listed = await store.list(repo.path)
      expect(listed.some((e) => e.kind === 'ticket' && e.ticket.parent === 'CAN-999')).toBe(true)
    })
  })
})
