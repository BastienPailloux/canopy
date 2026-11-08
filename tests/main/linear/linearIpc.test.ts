import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { LinearClient, type McpCaller } from '../../../src/main/linear/client'
import { LinearEdits } from '../../../src/main/linear/edits'
import { LinkedIssues, registerLinearIpc, startLinear } from '../../../src/main/linear/linearIpc'
import { LinearSync } from '../../../src/main/linear/sync'
import { localBranches } from '../../../src/main/tickets/ticketIpc'
import { TicketStore } from '../../../src/main/tickets/store'
import { fakeLinear, type FakeLinear } from '../../helpers/fakeLinear'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { selectLinearOpener, type ReplayOptions } from '../../../src/main/linear/replay'

let repo: TestRepo
let store: AppStore
let tickets: TicketStore
let opts: ReplayOptions
let fake: FakeLinear
let client: LinearClient
let edits: LinearEdits
let sync: LinearSync
let linked: LinkedIssues
let events: string[]
let handlers: Map<string, (...args: unknown[]) => unknown>

const call = (name: string, ...args: unknown[]): Promise<unknown> => {
  const fn = handlers.get(`linear:${name}`)
  if (!fn) throw new Error(`no handler linear:${name}`)
  return Promise.resolve().then(() => fn(...args))
}
const saves = (): number => fake.calls.filter((c) => c.name === 'save_issue').length

beforeEach(async () => {
  repo = await createRepo({ dirName: 'canopy' })
  const dir = await mkdtemp(join(tmpdir(), 'canopy-linear-ipc-'))
  store = new AppStore(join(dir, 'state.json'))
  tickets = new TicketStore()
  opts = {}
  fake = fakeLinear(opts)
  client = new LinearClient(vi.fn(async (): Promise<McpCaller> => fake), { saveLinearAuth: () => undefined })
  edits = new LinearEdits(join(dir, 'linear-pending.json'), client)
  linked = new LinkedIssues(store, localBranches)
  sync = new LinearSync(join(dir, 'linear-cache.json'), client, () => linked.ids())
  events = []
  handlers = new Map()
  registerLinearIpc({
    handle: (name, fn) => { handlers.set(name, fn) },
    client, edits, sync, linked, store,
    launch: { tickets, store, activity: () => 'idle', sessions: () => 0, trusted: async () => false },
    broadcast: (event) => { events.push(event) },
  })
  await client.connect()
})
afterEach(() => repo.cleanup())

describe('registerLinearIpc', () => {
  it('bad id refused', async () => {
    await expect(call('issue', 'can-1')).rejects.toThrow(/invalide/)
    await expect(call('issue', 'CAN-1; rm')).rejects.toThrow(/invalide/)
    await expect(call('save', 42, { title: 'x' })).rejects.toThrow(/invalide/)
    await expect(call('comment', '../CAN-1', 'hi')).rejects.toThrow(/invalide/)
    await expect(call('ackDepartures', ['CAN-1', 'nope'])).rejects.toThrow(/invalide/)
    await expect(call('list', 'relative/path')).rejects.toThrow(/invalide/)
    expect(fake.calls.filter((c) => c.name === 'get_issue')).toHaveLength(0)
  })

  it('unknown LinearChange key refused', async () => {
    await expect(call('save', 'CAN-1', { status: 'Done' })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { title: 'x'.repeat(201) })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { title: '  ' })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { description: { base: '', text: 'x'.repeat(100_001) } })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { description: 'plain' })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: ['x'.repeat(51)] })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { priority: 'p1' })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { assigneeId: 3 })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', {})).rejects.toThrow(/invalide/)
    await expect(call('discard', 'CAN-1', ['status'])).rejects.toThrow(/invalide/)
    await expect(call('comment', 'CAN-1', '')).rejects.toThrow(/invalide/)
    await expect(call('comment', 'CAN-1', 'x'.repeat(100_001))).rejects.toThrow(/invalide/)
    await expect(call('launch', repo.path, { id: 'CAN-1', branch: '-x', target: { kind: 'new', base: 'main' } })).rejects.toThrow(/invalide/)
    await expect(call('launch', repo.path, { id: 'CAN-1', branch: 'feat/x', target: { kind: 'other', base: 'main' } })).rejects.toThrow(/invalide/)
    expect(saves()).toBe(0)
    expect(edits.pending()).toEqual([])
  })

  it('disconnect refuses with pending edits', async () => {
    store.setLinearLink(repo.path, 'CAN-1', { branch: 'main', worktree: repo.path, base: 'main' })
    await call('refresh', repo.path)
    opts.failWith = new Error('network down')
    const r = await call('save', 'CAN-1', { title: 'Nouveau titre' }) as { kind: string }
    expect(r.kind).toBe('pending')
    expect(await call('pending')).toHaveLength(1)

    await expect(call('disconnect')).rejects.toThrow("Des modifications Linear n'ont pas été envoyées.")
    expect(client.connection().state).toBe('connected')

    await call('disconnect', true)
    expect(client.connection().state).toBe('disconnected')
    expect(edits.pending()).toEqual([])
    expect(sync.state().issues).toEqual([])
    expect(store.linearLinks(repo.path)).toHaveProperty('CAN-1')
    expect(events).toContain('linear:changed')
  })

  it('disconnect without pending edits needs no force', async () => {
    await call('disconnect')
    expect(await call('connection')).toMatchObject({ state: 'disconnected' })
  })

  it('local and linear CAN-1 stay distinct', async () => {
    const local = await tickets.create(repo.path, { title: 'Ticket local', description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
    expect(local.id).toBe('CAN-1')
    const remote = await call('issue', 'CAN-1') as { title: string }
    expect(remote.title).toBe('Get familiar with Linear')
    expect((await tickets.get(repo.path, 'CAN-1')).title).toBe('Ticket local')
  })

  it('list follows the linked issues of the repo whose branch exists', async () => {
    store.setLinearLink(repo.path, 'CAN-1', { branch: 'main', worktree: repo.path, base: 'main' })
    store.setLinearLink(repo.path, 'CAN-2', { branch: 'gone', worktree: repo.path, base: 'main' })
    await call('list', repo.path)
    expect(linked.ids()).toEqual(['CAN-1'])
    expect(await call('links', repo.path)).toHaveProperty('CAN-2')
  })

  it('a sent save refreshes the list and emits linear:changed', async () => {
    const before = fake.calls.filter((c) => c.name === 'list_issues').length
    const r = await call('save', 'CAN-1', { title: 'Renommé' }) as { kind: string }
    expect(r.kind).toBe('sent')
    await vi.waitFor(() => expect(fake.calls.filter((c) => c.name === 'list_issues').length).toBeGreaterThan(before))
    expect(events).toContain('linear:changed')
  })

  it('launch links the issue and follows it', async () => {
    const r = await call('launch', repo.path, { id: 'CAN-2', branch: 'feat/can-2', target: { kind: 'new', base: 'main' } }) as { worktree: string; issue: { id: string } }
    expect(r.issue.id).toBe('CAN-2')
    expect(execFileSync('git', ['branch', '--list', 'feat/can-2'], { cwd: repo.path }).toString()).toContain('feat/can-2')
    expect(await call('links', repo.path)).toEqual({ 'CAN-2': { branch: 'feat/can-2', worktree: r.worktree, base: 'main' } })
    expect(linked.ids()).toContain('CAN-2')
  })
})

describe('startLinear', () => {
  it('resumes, then resends the queue and refreshes when connected', async () => {
    const calls: string[] = []
    await startLinear({
      client: { resume: async () => { calls.push('resume'); return { state: 'connected', missingTools: [] } } },
      edits: { retryAll: async () => { calls.push('retry') } },
      sync: { refresh: async () => { calls.push('refresh'); return sync.state() } },
      broadcast: () => { calls.push('event') },
      log: () => undefined,
    })
    expect(calls).toEqual(['resume', 'event', 'retry', 'refresh'])
  })

  it('stays quiet when not connected and never throws', async () => {
    const calls: string[] = []
    const log = vi.fn()
    await startLinear({
      client: { resume: async () => { throw new Error('keychain locked') } },
      edits: { retryAll: async () => { calls.push('retry') } },
      sync: { refresh: async () => { calls.push('refresh'); return sync.state() } },
      broadcast: () => undefined,
      log,
    })
    expect(calls).toEqual([])
    expect(log).toHaveBeenCalled()
  })
})

describe('selectLinearOpener', () => {
  const real = vi.fn(async (): Promise<McpCaller> => { throw new Error('network') })

  it('CANOPY_FAKE_LINEAR replays the fixtures, connected from the start, without the real opener', async () => {
    const open = selectLinearOpener(real, { isPackaged: false, env: { CANOPY_FAKE_LINEAR: join(__dirname, '../../fixtures/linear') } })
    const c = new LinearClient(open, { saveLinearAuth: () => undefined })
    expect((await c.resume()).state).toBe('connected')
    expect((await c.issueBrief('CAN-1')).title).toBe('Get familiar with Linear')
    expect(real).not.toHaveBeenCalled()
  })

  it('is ignored when packaged or unset', () => {
    expect(selectLinearOpener(real, { isPackaged: true, env: { CANOPY_FAKE_LINEAR: '/x' } })).toBe(real)
    expect(selectLinearOpener(real, { isPackaged: false, env: {} })).toBe(real)
  })
})
