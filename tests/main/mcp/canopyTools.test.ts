import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanopyTools, parseKey, WRITE_TOOLS, type CanopyToolDeps } from '../../../src/main/mcp/canopyTools'
import { TicketStore } from '../../../src/main/tickets/store'
import { MockupStore } from '../../../src/main/mockups/store'
import type { TicketFields } from '../../../src/shared/tickets'
import type { LinearChange, LinearIssue, LinearIssueDetail, PendingEdit } from '../../../src/shared/linear'
import { createRepo, type TestRepo } from '../../helpers/repo'

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

    it('refuses unknown or Linear tickets and bad mockups', async () => {
      await expect(tools.link_mockup({ mockup: URL1, ticket: 'local:CAN-9' })).rejects.toThrow('Ticket introuvable : CAN-9')
      await expect(tools.link_mockup({ mockup: URL1, ticket: 'linear:ENG-1' })).rejects.toThrow("Une maquette ne se lie qu'à un ticket local.")
      await expect(tools.link_mockup({ mockup: 'nope', ticket: null })).rejects.toThrow('Maquette invalide : nope')
      expect(await mockups.list(repo.path)).toEqual({ kind: 'ok', mockups: [] })
    })
  })
})
