import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
    const bad = ': : not yaml\n'
    await writeFile(join(dir(), 'BAD-1.md'), bad)
    const list = await store.list(repo.path)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'unreadable', file: 'BAD-1.md' })
    expect(await readFile(join(dir(), 'BAD-1.md'), 'utf8')).toBe(bad)
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
})
