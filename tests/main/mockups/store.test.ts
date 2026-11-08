import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMockupChanges } from '../../../src/main/mockups/mockupIpc'
import { MockupStore } from '../../../src/main/mockups/store'
import { createRepo, type TestRepo } from '../../helpers/repo'

const SHORT = 'WcXTxNhxSWaDL28ttqjZye'
const URL = `https://claude.ai/artifact/${SHORT}`
const UUID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f'

let repo: TestRepo
let store: MockupStore
beforeEach(async () => {
  repo = await createRepo({ dirName: 'canopy' })
  store = new MockupStore()
})
afterEach(() => repo.cleanup())

const file = () => join(repo.path, '.mockups', 'mockups.json')
const readJson = async () => JSON.parse(await readFile(file(), 'utf8'))

describe('MockupStore', () => {
  it('lists nothing in a fresh repo, without creating anything', async () => {
    expect(await store.list(repo.path)).toEqual({ kind: 'ok', mockups: [] })
    expect(existsSync(join(repo.path, '.mockups'))).toBe(false)
  })

  it('add writes the registry in the main checkout and excludes it from git', async () => {
    const wt = join(repo.path, '..', 'wt')
    execFileSync('git', ['worktree', 'add', '-b', 'x', wt], { cwd: repo.path, stdio: 'pipe' })
    const m = await store.add(wt, `https://claude.ai/artifact/scanner-${SHORT}?v=1`, { kind: 'phone', ticket: 'DPP-12' })
    expect(m).toMatchObject({ id: SHORT, url: URL, kind: 'phone', status: 'todo', ticket: 'DPP-12' })
    expect(m.titleSet).toBeUndefined()
    expect(existsSync(join(wt, '.mockups'))).toBe(false)
    const doc = await readJson()
    expect(doc.version).toBe(1)
    expect(doc.mockups).toHaveLength(1)
    await store.add(repo.path, `https://claude.ai/code/artifact/${UUID}`)
    const ex = await readFile(join(repo.path, '.git/info/exclude'), 'utf8')
    expect(ex.split('\n').filter((l) => l.trim() === '/.mockups/')).toHaveLength(1)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo.path }).toString()).toBe('')
    expect(await store.list(repo.path)).toMatchObject({ kind: 'ok', mockups: [{ id: SHORT }, { id: UUID }] })
  })

  it('adding the same mockup twice keeps one entry, and links a ticket only if it had none', async () => {
    const first = await store.add(repo.path, URL)
    const again = await store.add(repo.path, `https://claude.ai/artifact/autre-titre-${SHORT}#x`, { ticket: 'DPP-1' })
    expect(again.id).toBe(first.id)
    expect(again.ticket).toBe('DPP-1')
    const third = await store.add(repo.path, URL, { ticket: 'DPP-2' })
    expect(third.ticket).toBe('DPP-1')
    expect((await readJson()).mockups).toHaveLength(1)
  })

  it('concurrent adds of the same url keep one entry', async () => {
    await Promise.all([store.add(repo.path, URL), store.add(repo.path, URL), store.add(repo.path, `https://claude.ai/code/artifact/${UUID}`)])
    expect((await readJson()).mockups).toHaveLength(2)
  })

  it('patch sets titleSet with a title, removes the ticket with null', async () => {
    await store.add(repo.path, URL, { ticket: 'DPP-1' })
    const t = await store.patch(repo.path, SHORT, { title: ' Scanner ' })
    expect(t).toMatchObject({ title: 'Scanner', titleSet: true, ticket: 'DPP-1' })
    const p = await store.patch(repo.path, SHORT, { title: 'Depuis la page', titleSet: false, ticket: null, status: 'done' })
    expect(p).toMatchObject({ title: 'Depuis la page', titleSet: false, status: 'done' })
    expect(p.ticket).toBeUndefined()
    expect((await readJson()).mockups[0]).not.toHaveProperty('ticket')
    await expect(store.patch(repo.path, `https://claude.ai/artifact/${SHORT}`, {})).rejects.toThrow(/invalide/)
    await expect(store.patch(repo.path, 'AAAAAAAAAAAAAAAAAAAAAA', {})).rejects.toThrow(/introuvable/)
  })

  it('patch keeps unknown keys, top-level and per mockup', async () => {
    await store.add(repo.path, URL)
    const doc = await readJson()
    doc.extra = { keep: true }
    doc.mockups[0].custom = 'hello'
    await writeFile(file(), JSON.stringify(doc))
    await store.patch(repo.path, SHORT, { status: 'wip' })
    const after = await readJson()
    expect(after.extra).toEqual({ keep: true })
    expect(after.mockups[0]).toMatchObject({ custom: 'hello', status: 'wip' })
  })

  it('remove forgets the mockup', async () => {
    await store.add(repo.path, URL)
    await store.add(repo.path, `https://claude.ai/code/artifact/${UUID}`)
    await store.remove(repo.path, SHORT)
    await store.remove(repo.path, SHORT)
    expect(await store.list(repo.path)).toMatchObject({ kind: 'ok', mockups: [{ id: UUID }] })
  })

  it('a broken registry is reported, and never rewritten', async () => {
    await mkdir(join(repo.path, '.mockups'))
    for (const bad of ['{ "version": 1, "mockups": [', '{"version":2,"mockups":[]}', `{"version":1,"mockups":[{"id":"${SHORT}"}]}`]) {
      await writeFile(file(), bad)
      const list = await store.list(repo.path)
      expect(list.kind).toBe('unreadable')
      if (list.kind === 'unreadable') expect(list.error).toMatch(/^mockups\.json illisible : /)
      await expect(store.add(repo.path, URL)).rejects.toThrow(/mockups\.json illisible/)
      await expect(store.patch(repo.path, SHORT, { status: 'done' })).rejects.toThrow(/mockups\.json illisible/)
      await expect(store.remove(repo.path, SHORT)).rejects.toThrow(/mockups\.json illisible/)
      expect(await readFile(file(), 'utf8')).toBe(bad)
    }
  })

  it('refuses a tracked .mockups', async () => {
    await repo.commit('.mockups/mockups.json', '{"version":1,"mockups":[]}')
    await expect(store.add(repo.path, URL)).rejects.toThrow(/suivi par git/)
    await expect(store.list(repo.path)).rejects.toThrow(/suivi par git/)
  })

  it('refuses a symlinked .mockups', async () => {
    const target = await mkdtemp(join(tmpdir(), 'canopy-link-'))
    try {
      await symlink(target, join(repo.path, '.mockups'))
      await expect(store.add(repo.path, URL)).rejects.toThrow(/vrai dossier/)
      expect(await readdir(target)).toEqual([])
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  it('rejects an invalid url', async () => {
    await expect(store.add(repo.path, 'https://evil.com/artifact/x')).rejects.toThrow(/invalide/)
  })
})

describe('parseMockupChanges', () => {
  it('keeps the known fields', () => {
    expect(parseMockupChanges({ title: 'A', kind: 'phone', status: 'wip', ticket: null, titleSet: false }))
      .toEqual({ title: 'A', kind: 'phone', status: 'wip', ticket: null, titleSet: false })
    expect(parseMockupChanges({ ticket: 'DPP-12' })).toEqual({ ticket: 'DPP-12' })
  })

  it('refuses unknown keys and bad values', () => {
    for (const raw of [
      null, [], { url: URL }, { title: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { kind: 'tablet' },
      { status: 'in_progress' }, { ticket: 'dpp-1' }, { ticket: '../x' }, { titleSet: 'yes' },
    ]) expect(() => parseMockupChanges(raw), JSON.stringify(raw)).toThrow(/invalide/)
  })
})
