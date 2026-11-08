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
let payloads: { ids?: string[] }[]
let handlers: Map<string, (...args: unknown[]) => unknown>
let refreshLinear: () => Promise<unknown>
let authStore: { saveLinearAuth: ReturnType<typeof vi.fn<(s: unknown) => void>> }
const OTHER_USER = '1bee77ed-5afd-459a-be6d-79125cddad1d'

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
  authStore = { saveLinearAuth: vi.fn<(s: unknown) => void>() }
  client = new LinearClient(vi.fn(async (): Promise<McpCaller> => fake), authStore)
  edits = new LinearEdits(join(dir, 'linear-pending.json'), client)
  linked = new LinkedIssues(store, localBranches)
  sync = new LinearSync(join(dir, 'linear-cache.json'), client, () => linked.ids(), undefined, () => edits.pending().map((p) => p.id))
  events = []
  payloads = []
  handlers = new Map()
  ;({ refresh: refreshLinear } = registerLinearIpc({
    handle: (name, fn) => { handlers.set(name, fn) },
    client, edits, sync, linked, store,
    launch: { tickets, store, activity: () => 'idle', sessions: () => 0, trusted: async () => false },
    broadcast: (event, payload) => { events.push(event); if (event === 'linear:changed') payloads.push(payload as { ids?: string[] }) },
  }))
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
    await expect(call('save', 'CAN-1', { title: 'x'.repeat(1001) })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { title: '  ' })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { description: { base: '', text: 'x'.repeat(100_001) } })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { description: 'plain' })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { description: { base: 'x'.repeat(100_001), text: '' } })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: ['Bug'] })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: { base: [], next: Array.from({ length: 101 }, (_, i) => `l${i}`) } })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: { base: Array.from({ length: 101 }, (_, i) => `l${i}`), next: [] } })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: { base: [], next: ['x'.repeat(201)] } })).rejects.toThrow(/invalide/)
    await expect(call('save', 'CAN-1', { labels: { base: [1], next: [] } })).rejects.toThrow(/invalide/)
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

  it('Linear limits, not the local ones: a long title and many labels go through validation', async () => {
    opts.failWith = new Error('fetch failed') // queued, not sent: only validation matters here
    await expect(call('save', 'CAN-1', { title: 'x'.repeat(1000) })).resolves.toMatchObject({ kind: 'pending' })
    await expect(call('save', 'CAN-1', { title: 'x'.repeat(1001) })).rejects.toThrow(/invalide/)
    const many = Array.from({ length: 100 }, (_, i) => `${'l'.repeat(190)}${i}`)
    await expect(call('save', 'CAN-1', { labels: { base: [], next: many } })).resolves.toMatchObject({ kind: 'pending' })
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

  it('a forced disconnect that fails keeps the queue', async () => {
    opts.failWith = new Error('network down')
    await call('save', 'CAN-1', { title: 'Nouveau titre' })
    authStore.saveLinearAuth.mockImplementation(() => { throw new Error('trousseau indisponible') })
    await expect(call('disconnect', true)).rejects.toThrow('trousseau indisponible')
    expect(edits.pending()).toHaveLength(1)
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

  it('launched set: linked issues of every repo whose branch exists; an unreadable root keeps its links', async () => {
    const other = await createRepo({ dirName: 'other' })
    try {
      store.setLinearLink(repo.path, 'CAN-1', { branch: 'main', worktree: repo.path, base: 'main' })
      store.setLinearLink(repo.path, 'CAN-2', { branch: 'gone', worktree: repo.path, base: 'main' })
      store.setLinearLink(other.path, 'CAN-3', { branch: 'main', worktree: other.path, base: 'main' })
      store.setLinearLink('/nowhere/at/all', 'CAN-4', { branch: 'main', worktree: '/nowhere/at/all', base: 'main' })
      await call('list', repo.path)
      expect(linked.ids().sort()).toEqual(['CAN-1', 'CAN-3', 'CAN-4'])
      expect(await call('links', repo.path)).toHaveProperty('CAN-2')
    } finally { await other.cleanup() }
  })

  it('a launched issue of repo A stays listed while following repo B, and departs for its true reason once its branch is gone', async () => {
    const b = await createRepo({ dirName: 'repo-b' })
    try {
      execFileSync('git', ['branch', 'feat/can-1'], { cwd: repo.path })
      store.setLinearLink(repo.path, 'CAN-1', { branch: 'feat/can-1', worktree: repo.path, base: 'main' })
      await call('refresh', repo.path)
      expect((await call('save', 'CAN-1', { assigneeId: OTHER_USER }) as { kind: string }).kind).toBe('sent')
      await sync.refresh()

      const st = await call('refresh', b.path) as { issues: { id: string }[]; departures: unknown[] }
      expect(st.issues.map((i) => i.id)).toContain('CAN-1')
      expect(st.departures).toEqual([])
      expect((await call('list', b.path) as { issues: { id: string }[] }).issues.map((i) => i.id)).toContain('CAN-1')

      execFileSync('git', ['branch', '-D', 'feat/can-1'], { cwd: repo.path })
      await call('refresh', b.path)
      const after = await call('refresh', b.path) as { issues: { id: string }[]; departures: { id: string; reason: string }[] }
      expect(after.issues.map((i) => i.id)).not.toContain('CAN-1')
      expect(after.departures.filter((d) => d.id === 'CAN-1')).toEqual([{ id: 'CAN-1', title: expect.any(String), reason: 'reassigned' }])
    } finally { await b.cleanup() }
  })

  it('connecting after an expired start refreshes with the launched set ready: no false departure', async () => {
    execFileSync('git', ['branch', 'feat/can-1'], { cwd: repo.path })
    store.setLinearLink(repo.path, 'CAN-1', { branch: 'feat/can-1', worktree: repo.path, base: 'main' })
    await sync.refresh() // the cache from an earlier run: CAN-1 listed
    await client.save('CAN-1', { assignee: OTHER_USER }) // reassigned in Linear meanwhile
    await client.disconnect()
    expect(linked.ids()).toEqual([]) // nothing recomputed yet, as at an expired start
    const refreshed = new Promise<void>((resolve) => { sync.onChange(() => resolve()) })
    await call('connect')
    await refreshed
    const st = sync.state()
    expect(st.issues.map((i) => i.id)).toContain('CAN-1')
    expect(st.departures).toEqual([])
  })

  it('a failed read of the links still answers the list and the refresh', async () => {
    await call('refresh', repo.path)
    vi.spyOn(linked, 'recompute').mockRejectedValue(new Error('git exploded'))
    expect((await call('list', repo.path) as { issues: unknown[] }).issues).toHaveLength(4)
    expect((await call('refresh', repo.path) as { issues: unknown[] }).issues).toHaveLength(4)
  })

  it('linear:changed names the issues touched: a save gives its id, a connection change none', async () => {
    await call('refresh', repo.path)
    payloads.length = 0
    await call('save', 'CAN-2', { priority: 'high' })
    await vi.waitFor(() => expect(payloads.some((p) => p.ids?.includes('CAN-2') && p.ids.length === 1)).toBe(true))
    expect(payloads.every((p) => Array.isArray(p.ids))).toBe(true)
    payloads.length = 0
    await call('disconnect')
    expect(payloads).toContainEqual({})
  })

  it('a launched issue Linear cannot find departs once and keeps its link: no lookup until a reconnect', async () => {
    store.setLinearLink(repo.path, 'CAN-9999', { branch: 'main', worktree: repo.path, base: 'main' })
    const st = await call('refresh', repo.path) as { departures: { id: string; reason: string }[] }
    expect(st.departures).toEqual([{ id: 'CAN-9999', title: 'CAN-9999', reason: 'missing' }])
    expect(store.linearLinks(repo.path)['CAN-9999']).toMatchObject({ branch: 'main' })
    fake.calls.length = 0
    await call('refresh', repo.path)
    await call('refresh', repo.path)
    expect(fake.calls.filter((c) => c.name === 'get_issue')).toEqual([])
    await call('connect')
    await vi.waitFor(() => expect(fake.calls.filter((c) => c.name === 'get_issue').map((c) => (c.args as { id: string }).id)).toContain('CAN-9999'))
  })

  it('list reads the launched set again unless told the event changed no link', async () => {
    const spy = vi.spyOn(linked, 'recompute')
    await call('list', repo.path)
    expect(spy).toHaveBeenCalledTimes(1)
    await call('list', repo.path, false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a sent save refreshes the list and emits linear:changed', async () => {
    const before = fake.calls.filter((c) => c.name === 'list_issues').length
    const r = await call('save', 'CAN-1', { title: 'Renommé' }) as { kind: string }
    expect(r.kind).toBe('sent')
    await vi.waitFor(() => expect(fake.calls.filter((c) => c.name === 'list_issues').length).toBeGreaterThan(before))
    expect(events).toContain('linear:changed')
  })

  it('a refresh that reaches Linear resends the edits that failed, not the held fields', async () => {
    opts.failWith = new Error('fetch failed')
    await call('save', 'CAN-1', { title: 'Hors ligne' })
    opts.failWith = undefined
    await call('save', 'CAN-2', { labels: { base: [], next: ['Nope'] } }) // refused by Linear: held, Bastien decides
    fake.calls.length = 0
    await call('refresh', repo.path)
    await vi.waitFor(() => expect(edits.pending().map((p) => p.id)).toEqual(['CAN-2']))
    const sent = fake.calls.filter((c) => c.name === 'save_issue').map((c) => c.args)
    expect(sent).toEqual([{ id: 'CAN-1', title: 'Hors ligne' }])
  })

  it('a failed refresh resends nothing', async () => {
    opts.failWith = new Error('fetch failed')
    await call('save', 'CAN-1', { title: 'Hors ligne' })
    fake.calls.length = 0
    await call('refresh', repo.path)
    await new Promise((r) => setTimeout(r, 20))
    expect(edits.pending()).toHaveLength(1)
  })

  it('registerLinearIpc gives the refresh used on system resume', async () => {
    opts.failWith = new Error('fetch failed')
    await call('save', 'CAN-1', { title: 'Hors ligne' })
    opts.failWith = undefined
    await refreshLinear()
    await vi.waitFor(() => expect(edits.pending()).toEqual([]))
  })

  it('started offline: a refresh tries the stored tokens again, then resends the queue', async () => {
    opts.failWith = new Error('fetch failed')
    await call('save', 'CAN-1', { title: 'Hors ligne' })
    await client.disconnect()
    await client.resume()
    expect(client.connection()).toMatchObject({ state: 'offline', error: expect.stringMatching(/injoignable/) })
    const down = await call('refresh', repo.path) as { error: string | null }
    expect(down.error).toMatch(/Linear injoignable : fetch failed/)
    expect(client.connection().state).toBe('offline')

    opts.failWith = undefined
    events.length = 0
    fake.calls.length = 0
    const up = await call('refresh', repo.path) as { error: string | null; issues: unknown[] }
    expect(up.error).toBeNull()
    expect(up.issues).toHaveLength(4)
    expect(client.connection().state).toBe('connected')
    expect(events).toContain('linear:changed')
    await vi.waitFor(() => expect(edits.pending()).toEqual([]))
    expect(fake.calls.filter((c) => c.name === 'save_issue').map((c) => c.args)).toEqual([{ id: 'CAN-1', title: 'Hors ligne' }])
  })

  it('a send while offline is not uncertain: nothing reached Linear', async () => {
    await client.disconnect()
    opts.failWith = new Error('fetch failed')
    await client.resume()
    opts.failWith = undefined
    const r = await call('save', 'CAN-1', { description: { base: 'a', text: 'b' } }) as { kind: string; reason: string }
    expect(r).toMatchObject({ kind: 'pending', reason: expect.stringMatching(/injoignable/) })
    expect(edits.pending()[0].uncertain).toBe(false)
  })

  it('an issue kept for its unsent edit departs with its reason as soon as the edit is discarded', async () => {
    await call('refresh', repo.path)
    await call('save', 'CAN-2', { labels: { base: [], next: ['Nope'] } }) // refused: held
    await fake.callTool('save_issue', { id: 'CAN-2', state: 'Canceled' }) // canceled in Linear meanwhile
    const kept = await call('refresh', repo.path) as { issues: { id: string }[]; departures: unknown[] }
    expect(kept.issues.map((i) => i.id)).toContain('CAN-2')
    expect(kept.departures).toEqual([])

    await call('discard', 'CAN-2')
    await vi.waitFor(() => expect(sync.state().departures).toEqual([{ id: 'CAN-2', title: expect.any(String), reason: 'canceled' }]))
    expect(sync.state().issues.map((i) => i.id)).not.toContain('CAN-2')
  })

  it('launch links the issue and follows it', async () => {
    const r = await call('launch', repo.path, { id: 'CAN-2', branch: 'feat/can-2', target: { kind: 'new', base: 'main' } }) as { worktree: string; issue: { id: string } }
    expect(r.issue.id).toBe('CAN-2')
    expect(execFileSync('git', ['branch', '--list', 'feat/can-2'], { cwd: repo.path }).toString()).toContain('feat/can-2')
    expect(await call('links', repo.path)).toEqual({ 'CAN-2': { branch: 'feat/can-2', worktree: r.worktree, base: 'main' } })
    expect(linked.ids()).toContain('CAN-2')
  })

  it("launch gives the issue with Bastien's queued description", async () => {
    opts.failWith = new Error('fetch failed')
    const base = (await client.issueBrief('CAN-2').catch(() => null))?.description ?? ''
    await edits.save('CAN-2', { description: { base, text: 'Texte encore en attente' } })
    opts.failWith = undefined
    const r = await call('launch', repo.path, { id: 'CAN-2', branch: 'feat/can-2', target: { kind: 'new', base: 'main' } }) as { issue: { description: string } }
    expect(r.issue.description).toBe('Texte encore en attente')
  })
})

describe('startLinear', () => {
  it('resumes, then resends the queue and refreshes when connected', async () => {
    const calls: string[] = []
    await startLinear({
      client: { resume: async () => { calls.push('resume'); return { state: 'connected', missingTools: [] } } },
      linked: { recompute: async () => { calls.push('links') } },
      edits: { retryAll: async () => { calls.push('retry') } },
      sync: { refresh: async () => { calls.push('refresh'); return sync.state() }, markExpired: () => { calls.push('expired') } },
      broadcast: () => { calls.push('event') },
      log: () => undefined,
    })
    expect(calls).toEqual(['links', 'resume', 'event', 'retry', 'refresh'])
  })

  it('offline at start: no resend, but the list records why it is stale', async () => {
    const calls: string[] = []
    await startLinear({
      client: { resume: async () => { calls.push('resume'); return { state: 'offline', error: 'Linear injoignable : x', missingTools: [] } } },
      linked: { recompute: async () => { calls.push('links') } },
      edits: { retryAll: async () => { calls.push('retry') } },
      sync: { refresh: async () => { calls.push('refresh'); return sync.state() }, markExpired: () => { calls.push('expired') } },
      broadcast: () => { calls.push('event') },
      log: () => undefined,
    })
    expect(calls).toEqual(['links', 'resume', 'event', 'refresh'])
  })

  it('expired at start: the list shows it at once, without a call to Linear', async () => {
    const calls: string[] = []
    await startLinear({
      client: { resume: async () => { calls.push('resume'); return { state: 'expired', missingTools: [] } } },
      linked: { recompute: async () => { calls.push('links') } },
      edits: { retryAll: async () => { calls.push('retry') } },
      sync: { refresh: async () => { calls.push('refresh'); return sync.state() }, markExpired: () => { calls.push('expired') } },
      broadcast: () => { calls.push('event') },
      log: () => undefined,
    })
    expect(calls).toEqual(['links', 'resume', 'expired', 'event'])
  })

  it('stays quiet when not connected and never throws', async () => {
    const calls: string[] = []
    const log = vi.fn()
    await startLinear({
      client: { resume: async () => { throw new Error('keychain locked') } },
      linked: { recompute: async () => { calls.push('links') } },
      edits: { retryAll: async () => { calls.push('retry') } },
      sync: { refresh: async () => { calls.push('refresh'); return sync.state() }, markExpired: () => { calls.push('expired') } },
      broadcast: () => undefined,
      log,
    })
    expect(calls).toEqual(['links'])
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
