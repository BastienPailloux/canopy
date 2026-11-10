import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanopyTools, parseKey, WRITE_TOOLS, type CanopyToolDeps } from '../../../src/main/mcp/canopyTools'
import { TicketStore } from '../../../src/main/tickets/store'
import { MockupStore } from '../../../src/main/mockups/store'
import type { TicketFields } from '../../../src/shared/tickets'
import type { LinearChange, LinearIssue, LinearIssueDetail, PendingEdit } from '../../../src/shared/linear'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { fakeLinear, type FakeLinear } from '../../helpers/fakeLinear'
import { LinearClient } from '../../../src/main/linear/client'
import { LinearFormatError } from '../../../src/main/linear/parse'
import { LinearEdits } from '../../../src/main/linear/edits'

const fields = (title: string, extra: Partial<TicketFields> = {}): TicketFields => ({
  title, description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [], ...extra,
})

const linearIssue = (id: string, title: string, extra: Partial<LinearIssue> = {}): LinearIssue => ({
  id, uuid: `uuid-${id}`, title, description: '', url: `https://linear.app/x/issue/${id}`,
  status: { id: null, name: 'Todo', type: 'unstarted' }, priority: 'none', labels: [], assignee: null,
  team: { id: 'team-1', name: 'Canopy' }, parentId: null, cycle: null, project: null, updatedAt: '2026-11-09T00:00:00Z', ...extra,
})

const URL1 = 'https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAAA'
const URL2 = 'https://claude.ai/artifact/BBBBBBBBBBBBBBBBBBBBBB'

describe('canopy read tools', () => {
  let repo: TestRepo
  let tickets: TicketStore
  let mockups: MockupStore
  let issues: LinearIssue[]
  let state: 'connected' | 'disconnected'
  let pending: PendingEdit[]
  let details: Record<string, LinearIssueDetail>
  let issueCalls: string[]
  let deps: CanopyToolDeps
  let tools: ReturnType<typeof createCanopyTools>

  beforeEach(async () => {
    repo = await createRepo()
    tickets = new TicketStore()
    await tickets.setPrefix(repo.path, 'CAN')
    mockups = new MockupStore()
    issues = []
    state = 'connected'
    pending = []
    details = {}
    issueCalls = []
    deps = {
      repoRoot: repo.path,
      mode: () => 'default',
      tickets,
      mockups,
      linear: {
        connection: () => ({ state, missingTools: [] }),
        issue: async (id: string) => { issueCalls.push(id); return details[id] },
        issueBrief: vi.fn(),
        teamOptions: async () => ({
          statuses: [{ id: 's1', name: 'Todo', type: 'unstarted' }, { id: 's2', name: 'Done', type: 'completed' }],
          labels: ['Bug', 'Feature'], users: [],
        }),
        createIssue: vi.fn(),
      } as unknown as CanopyToolDeps['linear'],
      edits: { save: vi.fn(), pending: () => pending },
      sync: { state: () => ({ issues }) as never, refresh: vi.fn() },
    }
    tools = createCanopyTools(deps)
  })
  afterEach(() => repo.cleanup())

  it('WRITE_TOOLS names the write tools', () => {
    expect(WRITE_TOOLS).toEqual(['create_ticket', 'update_ticket', 'link_mockup'])
  })

  it('parseKey splits and validates', () => {
    expect(parseKey('local:CAN-1')).toEqual({ source: 'local', id: 'CAN-1' })
    expect(parseKey('linear:ENG-482')).toEqual({ source: 'linear', id: 'ENG-482' })
    expect(parseKey('linear:can-3')).toEqual({ source: 'linear', id: 'CAN-3' })
    expect(() => parseKey('CAN-1')).toThrow('Clé de ticket invalide : CAN-1')
    expect(() => parseKey('local:../x')).toThrow('Clé de ticket invalide : local:../x')
  })

  describe('list_tickets', () => {
    it('lists local and Linear rows', async () => {
      const parent = await tickets.create(repo.path, fields('Parent'))
      const child = await tickets.create(repo.path, fields('Child', { parent: parent.id, labels: ['ui'], status: 'todo', priority: 'high', branch: 'feat/child' }))
      issues = [linearIssue('ENG-1', 'Remote', { parentId: 'ENG-0', labels: ['Bug'], priority: 'low' })]
      const rows = (await tools.list_tickets({})) as { tickets: Record<string, unknown>[] }
      expect(rows.tickets).toContainEqual({ key: `local:${parent.id}`, title: 'Parent', status: 'backlog', priority: 'none', labels: [], children: 1 })
      expect(rows.tickets).toContainEqual({ key: `local:${child.id}`, title: 'Child', status: 'todo', priority: 'high', labels: ['ui'], parent: `local:${parent.id}`, children: 0, branch: 'feat/child' })
      expect(rows.tickets).toContainEqual({ key: 'linear:ENG-1', title: 'Remote', status: 'Todo', priority: 'low', labels: ['Bug'], parent: 'linear:ENG-0' })
    })

    it('query is case and accent insensitive: local description, Linear title or label', async () => {
      await tickets.create(repo.path, fields('Alpha', { description: 'Add an export button' }))
      await tickets.create(repo.path, fields('Beta'))
      issues = [linearIssue('ENG-1', 'Évolution du schéma'), linearIssue('ENG-2', 'Other', { labels: ['Export'] }), linearIssue('ENG-3', 'Nope')]
      const keys = async (q: string) => ((await tools.list_tickets({ query: q })) as { tickets: { key: string }[] }).tickets.map((t) => t.key).sort()
      expect(await keys('EXPORT')).toEqual(['linear:ENG-2', 'local:CAN-1'])
      expect(await keys('Évolution')).toEqual(['linear:ENG-1'])
      expect(await keys('evolution')).toEqual(['linear:ENG-1'])
    })

    it('excludes done unless includeDone', async () => {
      await tickets.create(repo.path, fields('Open'))
      await tickets.create(repo.path, fields('Finished', { status: 'done' }))
      issues = [
        linearIssue('ENG-1', 'Open'),
        linearIssue('ENG-2', 'Completed', { status: { id: null, name: 'Done', type: 'completed' } }),
        linearIssue('ENG-3', 'Canceled', { status: { id: null, name: 'Canceled', type: 'canceled' } }),
      ]
      const keys = async (a: Record<string, unknown>) => ((await tools.list_tickets(a)) as { tickets: { key: string }[] }).tickets.map((t) => t.key).sort()
      expect(await keys({})).toEqual(['linear:ENG-1', 'local:CAN-1'])
      expect(await keys({ includeDone: true })).toHaveLength(5)
    })

    it('source local does not touch Linear', async () => {
      await tickets.create(repo.path, fields('Open'))
      const spy = vi.spyOn(deps.sync, 'state')
      const connection = vi.spyOn(deps.linear, 'connection')
      const r = (await tools.list_tickets({ source: 'local' })) as { tickets: unknown[] }
      expect(r.tickets).toHaveLength(1)
      expect(spy).not.toHaveBeenCalled()
      expect(connection).not.toHaveBeenCalled()
    })

    it('status filter: local status, Linear status name', async () => {
      await tickets.create(repo.path, fields('A', { status: 'todo' }))
      await tickets.create(repo.path, fields('B'))
      issues = [linearIssue('ENG-1', 'C'), linearIssue('ENG-2', 'D', { status: { id: null, name: 'In Progress', type: 'started' } })]
      const r = (await tools.list_tickets({ status: 'todo' })) as { tickets: { key: string }[] }
      expect(r.tickets.map((t) => t.key).sort()).toEqual(['linear:ENG-1', 'local:CAN-1'])
      const r2 = (await tools.list_tickets({ status: 'IN PROGRESS' })) as { tickets: { key: string }[] }
      expect(r2.tickets.map((t) => t.key)).toEqual(['linear:ENG-2'])
    })

    it('an explicit status filter includes done tickets without includeDone', async () => {
      await tickets.create(repo.path, fields('Open'))
      await tickets.create(repo.path, fields('Finished', { status: 'done' }))
      issues = [
        linearIssue('ENG-1', 'Open'),
        linearIssue('ENG-2', 'Completed', { status: { id: null, name: 'Done', type: 'completed' } }),
        linearIssue('ENG-3', 'Canceled', { status: { id: null, name: 'Canceled', type: 'canceled' } }),
      ]
      const keys = async (a: Record<string, unknown>) => ((await tools.list_tickets(a)) as { tickets: { key: string }[] }).tickets.map((t) => t.key).sort()
      expect(await keys({ status: 'done' })).toEqual(['linear:ENG-2', 'local:CAN-2'])
      expect(await keys({ status: 'canceled' })).toEqual(['linear:ENG-3'])
    })

    it('not connected: local rows plus linearError, no throw', async () => {
      await tickets.create(repo.path, fields('A'))
      issues = [linearIssue('ENG-1', 'C')]
      state = 'disconnected'
      const r = (await tools.list_tickets({})) as { tickets: { key: string }[]; linearError?: string }
      expect(r.tickets.map((t) => t.key)).toEqual(['local:CAN-1'])
      expect(r.linearError).toBe("Canopy n'est pas connecté à Linear.")
    })

    it('lists unreadable local files', async () => {
      const { writeFile, mkdir } = await import('node:fs/promises')
      await tickets.create(repo.path, fields('A'))
      await mkdir(`${repo.path}/.tickets`, { recursive: true })
      await writeFile(`${repo.path}/.tickets/CAN-9.md`, 'not a ticket')
      const r = (await tools.list_tickets({ source: 'local' })) as { tickets: unknown[]; unreadable?: { file: string; error: string }[] }
      expect(r.tickets).toHaveLength(1)
      expect(r.unreadable).toEqual([{ file: 'CAN-9.md', error: expect.any(String) }])
    })
  })

  describe('get_ticket', () => {
    it('local: all fields, parent, children, mockups', async () => {
      const parent = await tickets.create(repo.path, fields('Parent'))
      const t = await tickets.create(repo.path, fields('Me', { description: 'Body', parent: parent.id, subtasks: [{ title: 's', done: true }], status: 'todo' }))
      const kid = await tickets.create(repo.path, fields('Kid', { parent: t.id, status: 'done' }))
      await mockups.add(repo.path, URL1, { title: 'Screen', ticket: t.id })
      await mockups.add(repo.path, URL2, { title: 'Other' })
      const r = (await tools.get_ticket({ key: `local:${t.id}` })) as Record<string, unknown>
      expect(r).toMatchObject({
        key: `local:${t.id}`, title: 'Me', description: 'Body', status: 'todo', priority: 'none', labels: [],
        subtasks: [{ title: 's', done: true }],
        parent: { key: `local:${parent.id}`, title: 'Parent' },
        children: [{ key: `local:${kid.id}`, title: 'Kid', status: 'done' }],
      })
      expect(r.mockups).toEqual([{ id: 'AAAAAAAAAAAAAAAAAAAAAA', title: 'Screen', url: URL1, kind: expect.any(String), status: expect.any(String) }])
    })

    it('local: missing parent', async () => {
      const t = await tickets.create(repo.path, fields('Me'))
      await tickets.patch(repo.path, t.id, { parent: undefined })
      const { readFile, writeFile } = await import('node:fs/promises')
      const file = `${repo.path}/.tickets/${t.id}.md`
      const text = await readFile(file, 'utf8')
      await writeFile(file, text.replace(/^---\n/, '---\nparent: CAN-99\n'))
      const r = (await tools.get_ticket({ key: `local:${t.id}` })) as { parent: unknown }
      expect(r.parent).toEqual({ key: 'local:CAN-99', missing: true })
    })

    it('linear: detail, children, team options', async () => {
      details['ENG-1'] = {
        ...linearIssue('ENG-1', 'Remote', { description: 'Full text', labels: ['Bug'], parentId: 'ENG-0' }),
        children: [{ id: 'ENG-2', title: 'Kid', status: { id: null, name: 'Todo', type: 'unstarted' } }],
        comments: [],
      }
      const r = (await tools.get_ticket({ key: 'linear:ENG-1' })) as Record<string, unknown>
      expect(r).toMatchObject({
        key: 'linear:ENG-1', title: 'Remote', description: 'Full text', status: 'Todo', labels: ['Bug'], parent: 'linear:ENG-0',
        children: [{ key: 'linear:ENG-2', title: 'Kid', status: 'Todo' }],
        statuses: ['Todo', 'Done'], availableLabels: ['Bug', 'Feature'],
      })
      expect(r.pending).toBeUndefined()
    })

    it('linear: a pending edit on another issue is ignored', async () => {
      details['ENG-1'] = { ...linearIssue('ENG-1', 'Remote', { description: 'Old' }), children: [], comments: [] }
      pending = [{ id: 'ENG-2', change: { title: 'Other' }, error: '', held: {}, uncertain: false }]
      const r = (await tools.get_ticket({ key: 'linear:ENG-1' })) as Record<string, unknown>
      expect(r).toMatchObject({ title: 'Remote', description: 'Old' })
      expect(r.pending).toBeUndefined()
    })

    it('linear: a pending edit shows its version', async () => {
      details['ENG-1'] = { ...linearIssue('ENG-1', 'Remote', { description: 'Old', labels: ['Bug'] }), children: [], comments: [] }
      const change: LinearChange = { title: 'Mine', description: { base: 'Old', text: 'Mine text' }, labels: { base: ['Bug'], next: ['Bug', 'Feature'] } }
      pending = [{ id: 'ENG-1', change, error: '', held: {}, uncertain: false }]
      const r = (await tools.get_ticket({ key: 'linear:ENG-1' })) as Record<string, unknown>
      expect(r).toMatchObject({ title: 'Mine', description: 'Mine text', labels: ['Bug', 'Feature'], pending: true })
    })

    it('linear not connected', async () => {
      state = 'disconnected'
      await expect(tools.get_ticket({ key: 'linear:ENG-1' })).rejects.toThrow("Canopy n'est pas connecté à Linear.")
      expect(issueCalls).toEqual([])
    })

    it('malformed key', async () => {
      await expect(tools.get_ticket({ key: 'nope' })).rejects.toThrow('Clé de ticket invalide : nope')
      await expect(tools.get_ticket({ key: 'local:../etc' })).rejects.toThrow('Clé de ticket invalide : local:../etc')
    })
  })

  describe('list_mockups', () => {
    beforeEach(async () => {
      await mockups.add(repo.path, URL1, { title: 'One', ticket: 'CAN-1' })
      await mockups.add(repo.path, URL2, { title: 'Two' })
    })

    it('lists, filters by ticket and unlinked', async () => {
      const ids = async (a: Record<string, unknown>) => ((await tools.list_mockups(a)) as { mockups: { title: string }[] }).mockups.map((m) => m.title).sort()
      expect(await ids({})).toEqual(['One', 'Two'])
      expect(await ids({ ticket: 'local:CAN-1' })).toEqual(['One'])
      expect(await ids({ unlinked: true })).toEqual(['Two'])
      const one = ((await tools.list_mockups({ ticket: 'local:CAN-1' })) as { mockups: Record<string, unknown>[] }).mockups[0]
      expect(one).toMatchObject({ id: 'AAAAAAAAAAAAAAAAAAAAAA', url: URL1, title: 'One', ticket: 'local:CAN-1' })
    })

    it('rejects a non-local ticket key', async () => {
      await expect(tools.list_mockups({ ticket: 'linear:ENG-1' })).rejects.toThrow('Les maquettes ne se lient qu’à des tickets locaux.')
    })

    it('unreadable registry throws its error', async () => {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(`${repo.path}/.mockups/mockups.json`, '{broken')
      await expect(tools.list_mockups({})).rejects.toThrow(/JSON invalide/)
    })
  })

  it('get_ticket: an unreadable mockup registry does not fail the call', async () => {
    const { writeFile } = await import('node:fs/promises')
    const t = await tickets.create(repo.path, fields('One'))
    await mockups.add(repo.path, URL1, { ticket: t.id })
    await writeFile(`${repo.path}/.mockups/mockups.json`, '{broken')
    const r = (await tools.get_ticket({ key: 'local:CAN-1' })) as { title: string; mockups: unknown[]; mockupsError: string }
    expect(r.title).toBe('One')
    expect(r.mockups).toEqual([])
    expect(r.mockupsError).toMatch(/JSON invalide/)
  })

  describe('local writes', () => {
    it('create_ticket writes the file with defaults and a parent', async () => {
      await tickets.create(repo.path, fields('Parent'))
      const r = await tools.create_ticket({ source: 'local', title: 'Child', parent: 'local:CAN-1' })
      expect(r).toEqual({ key: 'local:CAN-2' })
      const t = await tickets.get(repo.path, 'CAN-2')
      expect(t).toMatchObject({ title: 'Child', parent: 'CAN-1', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(`${repo.path}/.tickets/CAN-2.md`, 'utf8')).toContain('parent: CAN-1')
    })

    it('create_ticket refuses a parent of another source and bad fields', async () => {
      await expect(tools.create_ticket({ source: 'local', title: 'x', parent: 'linear:ENG-1' })).rejects.toThrow('Le parent doit venir de la même source que le ticket.')
      await expect(tools.create_ticket({ source: 'local', title: 'x'.repeat(1000) })).rejects.toThrow('Titre invalide')
      await expect(tools.create_ticket({ source: 'local', title: 'x', status: 'nope' })).rejects.toThrow('Statut inconnu : nope. Statuts possibles : backlog, todo, in_progress, in_review, done')
      await expect(tools.create_ticket({ source: 'local', title: 'x', parent: 'local:CAN-9' })).rejects.toThrow('Parent introuvable : CAN-9')
    })

    it('update_ticket patches fields and removes the parent', async () => {
      await tickets.create(repo.path, fields('Parent'))
      await tickets.create(repo.path, fields('Child', { parent: 'CAN-1' }))
      const r = await tools.update_ticket({ key: 'local:CAN-2', title: 'New', description: 'D', status: 'todo', priority: 'high', labels: ['a'], parent: null })
      expect(r).toEqual({ key: 'local:CAN-2' })
      const t = await tickets.get(repo.path, 'CAN-2')
      expect(t).toMatchObject({ title: 'New', description: 'D', status: 'todo', priority: 'high', labels: ['a'] })
      expect(t.parent).toBeUndefined()
    })

    it('update_ticket validates', async () => {
      await tickets.create(repo.path, fields('One'))
      await tickets.create(repo.path, fields('Two', { parent: 'CAN-1' }))
      await expect(tools.update_ticket({ key: 'local:CAN-1' })).rejects.toThrow('Rien à modifier.')
      await expect(tools.update_ticket({ key: 'local:CAN-1', status: 'zzz' })).rejects.toThrow('Statut inconnu : zzz. Statuts possibles : backlog, todo, in_progress, in_review, done')
      await expect(tools.update_ticket({ key: 'local:CAN-1', title: 'x'.repeat(1000) })).rejects.toThrow('Titre invalide')
      await expect(tools.update_ticket({ key: 'local:CAN-1', parent: 'linear:ENG-1' })).rejects.toThrow('Le parent doit venir de la même source que le ticket.')
      await expect(tools.update_ticket({ key: 'local:CAN-1', parent: 'local:CAN-2' })).rejects.toThrow('Ce parent créerait une boucle : CAN-2')
      await expect(tools.update_ticket({ key: 'local:CAN-1', parent: 'local:CAN-9' })).rejects.toThrow('Parent introuvable : CAN-9')
      await expect(tools.update_ticket({ key: 'local:CAN-9', title: 'x' })).rejects.toThrow('Ticket introuvable : CAN-9')
    })

    it('plan mode refuses every write, reads the mode at each call', async () => {
      let mode: string = 'plan'
      const planTools = createCanopyTools({ ...deps, mode: () => mode as never })
      await tickets.create(repo.path, fields('One'))
      const msg = 'Mode plan : Canopy ne modifie rien tant que la session est en mode plan.'
      await expect(planTools.create_ticket({ source: 'local', title: 'x' })).rejects.toThrow(msg)
      await expect(planTools.update_ticket({ key: 'local:CAN-1', title: 'x' })).rejects.toThrow(msg)
      await expect(planTools.link_mockup({ mockup: URL1, ticket: 'local:CAN-1' })).rejects.toThrow(msg)
      expect((await tickets.list(repo.path)).length).toBe(1)
      expect((await tickets.get(repo.path, 'CAN-1')).title).toBe('One')
      await expect(planTools.list_tickets({})).resolves.toBeDefined()
      mode = 'default'
      await expect(planTools.create_ticket({ source: 'local', title: 'x' })).resolves.toEqual({ key: 'local:CAN-2' })
    })
  })

  describe('link_mockup', () => {
    it('links by id with a status, then unlinks', async () => {
      await tickets.create(repo.path, fields('One'))
      await mockups.add(repo.path, URL1, { title: 'M' })
      await tools.link_mockup({ mockup: 'AAAAAAAAAAAAAAAAAAAAAA', ticket: 'local:CAN-1', status: 'wip' })
      let m = (await mockups.list(repo.path) as { mockups: { ticket?: string; status: string }[] }).mockups[0]
      expect(m).toMatchObject({ ticket: 'CAN-1', status: 'wip' })
      await tools.link_mockup({ mockup: 'AAAAAAAAAAAAAAAAAAAAAA', ticket: null })
      m = (await mockups.list(repo.path) as { mockups: { ticket?: string; status: string }[] }).mockups[0]
      expect(m.ticket).toBeUndefined()
    })

    it('adds an unregistered URL then links it', async () => {
      await tickets.create(repo.path, fields('One'))
      await tools.link_mockup({ mockup: URL2, ticket: 'local:CAN-1' })
      const list = (await mockups.list(repo.path) as { mockups: { id: string; ticket?: string }[] }).mockups
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id: 'BBBBBBBBBBBBBBBBBBBBBB', ticket: 'CAN-1' })
    })

    it('a new mockup added but not linked says so', async () => {
      await tickets.create(repo.path, fields('One'))
      vi.spyOn(mockups, 'patch').mockRejectedValue(new Error('disque plein'))
      await expect(tools.link_mockup({ mockup: URL2, ticket: 'local:CAN-1' })).rejects.toThrow('Maquette ajoutée mais non liée : disque plein')
      expect((await mockups.list(repo.path) as { mockups: unknown[] }).mockups).toHaveLength(1)
      // Already registered: nothing was added, the error stays as is.
      await expect(tools.link_mockup({ mockup: URL2, ticket: 'local:CAN-1' })).rejects.toThrow(/^disque plein$/)
      await expect(tools.link_mockup({ mockup: 'CCCCCCCCCCCCCCCCCCCCCC', ticket: 'local:CAN-1' })).rejects.toThrow(/^disque plein$/)
    })

    it('refuses unknown or Linear tickets and bad mockups', async () => {
      await expect(tools.link_mockup({ mockup: URL1, ticket: 'local:CAN-9' })).rejects.toThrow('Ticket introuvable : CAN-9')
      await expect(tools.link_mockup({ mockup: URL1, ticket: 'linear:ENG-1' })).rejects.toThrow("Une maquette ne se lie qu'à un ticket local.")
      await expect(tools.link_mockup({ mockup: 'nope', ticket: null })).rejects.toThrow('Maquette invalide : nope')
      expect(await mockups.list(repo.path)).toEqual({ kind: 'ok', mockups: [] })
    })
  })
})

describe('canopy Linear writes', () => {
  const dirs: string[] = []
  let fake: FakeLinear
  let client: LinearClient
  let edits: LinearEdits
  let failFile: string
  let issues: LinearIssue[]
  let refresh: ReturnType<typeof vi.fn>
  let tools: ReturnType<typeof createCanopyTools>

  const saves = () => fake.calls.filter((c) => c.name === 'save_issue').map((c) => c.args as Record<string, unknown>)
  const down = () => writeFileSync(failFile, '')
  const up = () => unlinkSync(failFile)

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopy-mcp-linear-'))
    dirs.push(dir)
    failFile = join(dir, 'down')
    fake = fakeLinear({ failFile })
    client = new LinearClient(async () => fake, { saveLinearAuth: () => {} })
    await client.connect()
    edits = new LinearEdits(join(dir, 'linear-pending.json'), client)
    issues = await client.listMine()
    refresh = vi.fn(async () => ({}))
    fake.calls.length = 0
    tools = createCanopyTools({
      repoRoot: dir,
      mode: () => 'default',
      tickets: new TicketStore(),
      mockups: new MockupStore(),
      linear: client,
      edits,
      sync: { state: () => ({ issues }) as never, refresh: refresh as never },
    })
  })
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  describe('update_ticket', () => {
    it('a lowercase key chains onto the pending edit of the same issue', async () => {
      await edits.save('CAN-3', { description: { base: 'X', text: 'X de Bastien' } })
      await tools.update_ticket({ key: 'linear:can-3', description: 'X de Bastien et Claude' })
      expect(edits.pending()).toHaveLength(1)
      expect(edits.pending()[0]).toMatchObject({ id: 'CAN-3', change: { description: { base: 'X', text: 'X de Bastien et Claude' } } })
    })

    it('Linear limits apply, not the local ones', async () => {
      const labels = Array.from({ length: 25 }, (_, i) => `L${i}`)
      await expect(tools.update_ticket({ key: 'linear:CAN-2', title: 'T'.repeat(300), labels })).resolves.toBeDefined()
      await expect(tools.update_ticket({ key: 'linear:CAN-2', title: 'T'.repeat(1001) })).rejects.toThrow('Titre invalide')
    })

    it('description goes out as a patch, never in full', async () => {
      await fake.callTool('save_issue', { id: 'CAN-2', description: 'A\n\nB' })
      fake.calls.length = 0
      await expect(tools.update_ticket({ key: 'linear:CAN-2', description: 'A\n\nB2' })).resolves.toEqual({ result: 'enregistré' })
      const [sent] = saves()
      expect(sent).not.toHaveProperty('description')
      expect(sent.patch).toEqual(expect.any(Array))
      expect((await client.issueBrief('CAN-2')).description).toBe('A\n\nB2')
    })

    it("builds on Bastien's unsent description and labels instead of replacing them", async () => {
      await fake.callTool('save_issue', { id: 'CAN-2', description: 'A\n\nB' })
      fake.calls.length = 0
      down()
      await edits.save('CAN-2', { description: { base: 'A\n\nB', text: 'A\n\nB de Bastien' }, labels: { base: [], next: ['Bug'] } })
      const mine = 'A\n\nB de Bastien\nligne de Claude'
      const r = (await tools.update_ticket({ key: 'linear:CAN-2', description: mine, labels: ['Bug', 'Feature'] })) as { result: string }
      expect(r.result).toMatch(/^en attente : /)
      expect(edits.pending()[0].change).toEqual({
        description: { base: 'A\n\nB', text: mine },
        labels: { base: [], next: ['Bug', 'Feature'] },
      })
      up()
      await edits.retryAll()
      const now = await client.issueBrief('CAN-2')
      expect(now.description).toBe(mine)
      expect(now.labels.sort()).toEqual(['Bug', 'Feature'])
      expect(saves().length).toBeGreaterThan(0)
      expect(saves().every((s) => s.description === undefined)).toBe(true)
    })

    it("on top of Bastien's unsent edit, a colleague's edit elsewhere is kept", async () => {
      await fake.callTool('save_issue', { id: 'CAN-2', description: 'A\n\nB' })
      down()
      await edits.save('CAN-2', { description: { base: 'A\n\nB', text: 'A\n\nB de Bastien' } })
      up()
      await fake.callTool('save_issue', { id: 'CAN-2', description: 'A du collègue\n\nB' })
      fake.calls.length = 0
      await expect(tools.update_ticket({ key: 'linear:CAN-2', description: 'A\n\nB de Bastien\nligne de Claude' })).resolves.toEqual({ result: 'enregistré' })
      expect((await client.issueBrief('CAN-2')).description).toBe('A du collègue\n\nB de Bastien\nligne de Claude')
      expect(saves().every((x) => x.description === undefined && Array.isArray(x.patch))).toBe(true)
    })

    it("a colleague's edit of the same passage is a conflict, reported in plain words", async () => {
      await fake.callTool('save_issue', { id: 'CAN-2', description: 'A\n\nB' })
      down()
      await edits.save('CAN-2', { description: { base: 'A\n\nB', text: 'A2\n\nB' } })
      up()
      await fake.callTool('save_issue', { id: 'CAN-2', description: 'A3\n\nB' })
      fake.calls.length = 0
      await expect(tools.update_ticket({ key: 'linear:CAN-2', description: 'A4\n\nB' }))
        .resolves.toEqual({ result: "conflit avec une modification d'un collègue : la description n'a pas été envoyée" })
      expect(saves()).toEqual([])
      expect((await client.issueBrief('CAN-2')).description).toBe('A3\n\nB')
    })

    it('status by name, case-insensitive; unknown lists the names', async () => {
      await expect(tools.update_ticket({ key: 'linear:CAN-2', status: 'in progress', priority: 'high', title: 'T' })).resolves.toEqual({ result: 'enregistré' })
      expect(saves()).toEqual([{ id: 'CAN-2', title: 'T', state: '65d36428-f47c-4f20-a820-43d226fb0577', priority: 2 }])
      await expect(tools.update_ticket({ key: 'linear:CAN-2', status: 'Nope' }))
        .rejects.toThrow('Statut inconnu : Nope. Statuts possibles : In Review, Done, Canceled, In Progress, Todo, Duplicate, Backlog')
    })

    it("refuses an issue that is neither Bastien's nor created in this session, and queues nothing", async () => {
      issues = issues.filter((i) => i.id !== 'CAN-2')
      await expect(tools.update_ticket({ key: 'linear:can-2', title: 'T' }))
        .rejects.toThrow('Canopy ne modifie que tes tickets Linear assignés et ceux créés dans cette session : CAN-2')
      expect(edits.pending()).toEqual([])
      expect(saves()).toEqual([])
    })

    it("refuses an issue still in the list but reassigned to a colleague, and queues nothing", async () => {
      issues = issues.map((i) => (i.id === 'CAN-2' ? { ...i, assignee: { id: 'colleague', name: 'Alice' } } : i))
      await expect(tools.update_ticket({ key: 'linear:CAN-2', title: 'T' }))
        .rejects.toThrow('Canopy ne modifie que tes tickets Linear assignés et ceux créés dans cette session : CAN-2')
      expect(edits.pending()).toEqual([])
      expect(saves()).toEqual([])
    })

    it('an issue of the list assigned to me can be updated', async () => {
      expect(issues.find((i) => i.id === 'CAN-2')?.assignee?.id).toBe(client.connection().userId)
      await expect(tools.update_ticket({ key: 'linear:CAN-2', title: 'T' })).resolves.toEqual({ result: 'enregistré' })
    })

    it('with an unknown user id, only the issues created in this session can be updated', async () => {
      const { key } = (await tools.create_ticket({ source: 'linear', title: 'New', parent: 'linear:CAN-3' })) as { key: string }
      vi.spyOn(client, 'connection').mockReturnValue({ state: 'connected', missingTools: [] } as never)
      await expect(tools.update_ticket({ key: 'linear:CAN-2', title: 'T' }))
        .rejects.toThrow('Canopy ne modifie que tes tickets Linear assignés et ceux créés dans cette session : CAN-2')
      await expect(tools.update_ticket({ key, title: 'Renamed' })).resolves.toEqual({ result: 'enregistré' })
    })

    it('an issue created by these tools can be updated, even before the list knows it', async () => {
      const { key } = (await tools.create_ticket({ source: 'linear', title: 'New', parent: 'linear:CAN-3' })) as { key: string }
      expect(issues.some((i) => `linear:${i.id}` === key)).toBe(false)
      await expect(tools.update_ticket({ key: key.toLowerCase(), title: 'Renamed' })).resolves.toEqual({ result: 'enregistré' })
    })

    it('refuses a parent change and an empty update', async () => {
      await expect(tools.update_ticket({ key: 'linear:CAN-2', parent: 'linear:CAN-3' }))
        .rejects.toThrow("Le parent d'un ticket Linear existant ne se change pas depuis Canopy.")
      await expect(tools.update_ticket({ key: 'linear:CAN-2', parent: null }))
        .rejects.toThrow("Le parent d'un ticket Linear existant ne se change pas depuis Canopy.")
      await expect(tools.update_ticket({ key: 'linear:CAN-2' })).rejects.toThrow('Rien à modifier.')
      await expect(tools.update_ticket({ key: 'linear:CAN-2', priority: 'nope' })).rejects.toThrow('Priorité invalide')
      expect(saves()).toEqual([])
    })
  })

  describe('create_ticket', () => {
    it('an unreadable answer after the creation is not an error: refresh and tell Claude to check', async () => {
      const spy = vi.spyOn(client, 'createIssue').mockRejectedValue(new LinearFormatError('save_issue', 'id'))
      const r = await tools.create_ticket({ source: 'linear', title: 'x' })
      expect(r).toEqual({ result: 'créé, mais la réponse de Linear est illisible : vérifie avec list_tickets avant de recréer' })
      expect(refresh).toHaveBeenCalled()
      spy.mockRestore()
      vi.spyOn(client, 'createIssue').mockRejectedValue(new Error('boom'))
      await expect(tools.create_ticket({ source: 'linear', title: 'x' })).rejects.toThrow('boom')
    })

    it('an unreadable answer: the new issue found in the refreshed list is returned and can be updated', async () => {
      const me = client.connection().userId ?? null
      const team = issues[0].team
      vi.spyOn(client, 'createIssue').mockRejectedValue(new LinearFormatError('save_issue', 'id'))
      const old = linearIssue('CAN-8', 'Same', { assignee: { id: me!, name: 'Bastien' }, updatedAt: '2020-01-01T00:00:00Z', team })
      issues = [...issues, old]
      refresh.mockImplementation(async () => {
        const now = new Date().toISOString()
        issues = [...issues,
          linearIssue('CAN-9', 'Same', { assignee: { id: 'colleague', name: 'Alice' }, updatedAt: now, team }),
          linearIssue('CAN-7', 'Same', { assignee: { id: me!, name: 'Bastien' }, updatedAt: now, team })]
        return {}
      })
      const r = await tools.create_ticket({ source: 'linear', title: 'Same' })
      expect(r).toEqual({ key: 'linear:CAN-7', result: 'créé (réponse de Linear lue depuis la liste)' })
      issues = issues.filter((i) => i.id !== 'CAN-7')
      vi.spyOn(client, 'issueBrief').mockResolvedValue(linearIssue('CAN-7', 'Same'))
      await expect(tools.update_ticket({ key: 'linear:CAN-7', priority: 'high' })).resolves.toBeDefined()
    })

    it("a sub-issue goes in the parent's team, then the list is refreshed", async () => {
      const r = await tools.create_ticket({ source: 'linear', title: 'Child', description: 'D', priority: 'high', labels: ['Bug'], status: 'todo', parent: 'linear:CAN-3' })
      expect(r).toEqual({ key: 'linear:CAN-5' })
      expect(saves()).toEqual([{
        title: 'Child', team: '78589deb-f061-45b7-b299-bb1c34d4b638', description: 'D', parentId: 'CAN-3', labels: ['Bug'],
        state: '2dadbe3f-ba74-4c3d-af57-8e01466b083a', assignee: 'me', priority: 2,
      }])
      expect(refresh).toHaveBeenCalled()
      expect(await client.issueBrief('CAN-5')).toMatchObject({ title: 'Child', parentId: 'CAN-3' })
    })

    it('team: the only known one, else the team argument, else an error listing them', async () => {
      await tools.create_ticket({ source: 'linear', title: 'Solo' })
      expect(saves()[0].team).toBe('78589deb-f061-45b7-b299-bb1c34d4b638')
      fake.calls.length = 0
      await tools.create_ticket({ source: 'linear', title: 'Empty team', team: '' })
      expect(saves()[0].team).toBe('78589deb-f061-45b7-b299-bb1c34d4b638')
      fake.calls.length = 0
      issues = [...issues, linearIssue('ENG-1', 'Other', { team: { id: 'team-eng', name: 'Engineering' } })]
      const msg = "Précise l'équipe Linear : Canopy, Engineering"
      await expect(tools.create_ticket({ source: 'linear', title: 'x' })).rejects.toThrow(msg)
      await expect(tools.create_ticket({ source: 'linear', title: 'x', team: 'Nope' })).rejects.toThrow(msg)
      expect(saves()).toEqual([])
      await tools.create_ticket({ source: 'linear', title: 'x', team: 'canopy' })
      expect(saves()[0].team).toBe('78589deb-f061-45b7-b299-bb1c34d4b638')
    })

    it('no known team: the team argument goes to Linear as is, none is an error', async () => {
      issues = []
      await expect(tools.create_ticket({ source: 'linear', title: 'x' })).rejects.toThrow(/^Précise l'équipe Linear\.$/)
      expect(saves()).toEqual([])
      await tools.create_ticket({ source: 'linear', title: 'x', team: 'Canopy' })
      expect(saves()[0].team).toBe('Canopy')
    })

    it('refuses a local parent', async () => {
      await expect(tools.create_ticket({ source: 'linear', title: 'x', parent: 'local:CAN-1' })).rejects.toThrow('Le parent doit venir de la même source que le ticket.')
    })
  })

  it('not connected: both tools refuse', async () => {
    await client.disconnect()
    await expect(tools.create_ticket({ source: 'linear', title: 'x' })).rejects.toThrow("Canopy n'est pas connecté à Linear.")
    await expect(tools.update_ticket({ key: 'linear:CAN-2', title: 'x' })).rejects.toThrow("Canopy n'est pas connecté à Linear.")
  })
})
