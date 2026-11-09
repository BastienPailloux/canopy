import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TicketStore } from '../../../src/main/tickets/store'
import type { TemplateFields, TicketFields } from '../../../src/shared/tickets'
import { TEMPLATE_SLUG_RE } from '../../../src/shared/tickets'
import { createRepo, type TestRepo } from '../../helpers/repo'

// Set by a test to make writing that path fail with EIO, an error other than « already exists ».
const failing = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: (async (file, ...rest) => {
      if (failing.path && String(file).endsWith(failing.path)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      return fs.writeFile(file, ...rest)
    }) as typeof fs.writeFile
  }
})

const fields = (): TicketFields => ({ title: 'Un ticket', description: 'desc', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
const tpl = (name: string): TemplateFields => ({ name, description: 'd', priority: 'none', labels: [], subtasks: [] })

let repo: TestRepo
let store: TicketStore
beforeEach(async () => {
  repo = await createRepo({ dirName: 'canopy' })
  store = new TicketStore()
})
afterEach(() => {
  failing.path = ''
  return repo.cleanup()
})

const tdir = () => join(repo.path, '.tickets', 'templates')

describe('TicketStore templates', () => {
  it('seeds the built-in templates once', async () => {
    const first = await store.templates(repo.path)
    expect(first.entries).toHaveLength(4)
    expect(first.defaultSlug).toBe('contexte')
    expect(existsSync(join(tdir(), 'bug.md'))).toBe(true)
    await store.deleteTemplate(repo.path, 'bug')
    const again = await store.templates(repo.path)
    expect(again.entries).toHaveLength(3)
    expect(existsSync(join(tdir(), 'bug.md'))).toBe(false)
  })

  it('fails when a built-in template cannot be written', async () => {
    failing.path = join('templates', 'bug.md')
    await expect(store.templates(repo.path)).rejects.toThrow('EIO')
  })

  it('does not seed when the folder exists empty', async () => {
    await mkdir(tdir(), { recursive: true })
    expect(await store.templates(repo.path)).toEqual({ entries: [], defaultSlug: null })
  })

  it('creates bug-2 when bug exists and keeps the slug on rename', async () => {
    await store.templates(repo.path)
    const t = await store.saveTemplate(repo.path, null, tpl('bug!'))
    expect(t.slug).toBe('bug-2')
    const r = await store.saveTemplate(repo.path, 'bug-2', tpl('Autre'))
    expect(r.slug).toBe('bug-2')
    expect(await readFile(join(tdir(), 'bug-2.md'), 'utf8')).toContain('name: Autre')
  })

  it('keeps suffixed slugs within 50 characters', async () => {
    await mkdir(tdir(), { recursive: true })
    const name = 'a'.repeat(50)
    await store.saveTemplate(repo.path, null, tpl(name))
    const t = await store.saveTemplate(repo.path, null, tpl(name))
    expect(t.slug).toMatch(TEMPLATE_SLUG_RE)
    expect(t.slug).toBe(`${'a'.repeat(48)}-2`)
  })

  it('refuses to save an unknown slug', async () => {
    await expect(store.saveTemplate(repo.path, 'nope', tpl('X'))).rejects.toThrow(/Modèle introuvable/)
  })

  it('lists an unreadable template without touching it', async () => {
    await mkdir(tdir(), { recursive: true })
    await writeFile(join(tdir(), 'oops.md'), 'no front matter')
    const list = await store.templates(repo.path)
    expect(list.entries).toMatchObject([{ kind: 'unreadable', file: 'oops.md' }])
    expect(await readFile(join(tdir(), 'oops.md'), 'utf8')).toBe('no front matter')
  })

  it('lists a file whose name is not a template slug as unreadable', async () => {
    await mkdir(tdir(), { recursive: true })
    const valid = '---\nname: Bug perso\n---\nbody\n'
    await writeFile(join(tdir(), 'Bug.md'), valid)
    await writeFile(join(tdir(), 'foo.bar.md'), valid)
    const list = await store.templates(repo.path)
    expect(list.entries).toMatchObject([
      { kind: 'unreadable', file: 'Bug.md', error: expect.stringMatching(/Nom de fichier/) },
      { kind: 'unreadable', file: 'foo.bar.md', error: expect.stringMatching(/Nom de fichier/) },
    ])
    expect(list.defaultSlug).toBeNull()
  })

  it('falls back to the first template when the default is gone', async () => {
    await store.templates(repo.path)
    await store.setDefaultTemplate(repo.path, 'bug')
    expect((await store.templates(repo.path)).defaultSlug).toBe('bug')
    await store.deleteTemplate(repo.path, 'bug')
    expect((await store.templates(repo.path)).defaultSlug).toBe('contexte')
  })

  it('keeps defaultTemplate when the prefix changes or a ticket is created', async () => {
    await store.templates(repo.path)
    await store.setDefaultTemplate(repo.path, 'refacto')
    await store.setPrefix(repo.path, 'ABC')
    await store.create(repo.path, fields())
    expect((await store.templates(repo.path)).defaultSlug).toBe('refacto')
    expect(await store.config(repo.path)).toMatchObject({ prefix: 'ABC', next: 2 })
  })

  it('setDefaultTemplate refuses an unknown slug', async () => {
    await store.templates(repo.path)
    await expect(store.setDefaultTemplate(repo.path, 'nope')).rejects.toThrow(/Modèle introuvable/)
  })

  it('refuses a tracked .tickets/templates', async () => {
    await mkdir(tdir(), { recursive: true })
    await writeFile(join(tdir(), 'x.md'), '---\nname: X\n---\n')
    execFileSync('git', ['add', '-f', '.tickets/templates/x.md'], { cwd: repo.path })
    execFileSync('git', ['commit', '-m', 'track'], { cwd: repo.path })
    await expect(store.templates(repo.path)).rejects.toThrow(/suivi par git/)
  })
})
