import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { describe, expect, it, vi } from 'vitest'
import {
  LINEAR_MCP_URL, LinearClient, LinearExpiredError, LinearNotConnectedError, LinearOfflineError, REQUIRED_TOOLS, linearOpener, type McpCaller,
} from '../../../src/main/linear/client'
import { LinearError } from '../../../src/main/linear/parse'
import type { ReplayOptions } from '../../../src/main/linear/replay'
import { fakeLinear, type FakeLinear } from '../../helpers/fakeLinear'

const TEAM = '78589deb-f061-45b7-b299-bb1c34d4b638'

const memoryStore = () => {
  const saved: unknown[] = []
  return { saved, saveLinearAuth: (s: unknown) => { saved.push(s) } }
}

async function connected(opts: ReplayOptions = {}, tweak?: (f: FakeLinear) => void) {
  const fake = fakeLinear(opts)
  tweak?.(fake)
  const store = memoryStore()
  const open = vi.fn(async (_interactive: boolean): Promise<McpCaller> => fake)
  const client = new LinearClient(open, store)
  await client.connect()
  return { client, fake, open, store }
}

const pages = (calls: FakeLinear['calls'], name: string) => calls.filter((c) => c.name === name).map((c) => c.args as Record<string, unknown>)

describe('LinearClient connection', () => {
  it('exports the server URL and the tools Canopy needs', () => {
    expect(LINEAR_MCP_URL).toBe('https://mcp.linear.app/mcp')
    expect(REQUIRED_TOOLS).toEqual(['whoami', 'list_issues', 'get_issue', 'save_issue', 'list_comments', 'save_comment', 'list_issue_statuses', 'list_issue_labels', 'list_users'])
  })

  it('starts disconnected; connect opens interactively and reads whoami', async () => {
    const fake = fakeLinear()
    const open = vi.fn(async () => fake)
    const client = new LinearClient(open, memoryStore())
    expect(client.connection()).toEqual({ state: 'disconnected', missingTools: [] })
    await expect(client.connect()).resolves.toEqual({ state: 'connected', workspace: 'canopy', email: 'bastien.pailloux@hotmail.fr', userId: '5d215785-3c9b-44ff-aa4c-f00a2c2229ee', missingTools: [] })
    expect(open).toHaveBeenCalledWith(true)
    expect(client.connection().state).toBe('connected')
  })

  it('missing tool is reported', async () => {
    const { client } = await connected({}, (f) => {
      const all = f.listTools.bind(f)
      f.listTools = async () => (await all()).filter((t) => t.name !== 'save_issue')
    })
    expect(client.connection()).toMatchObject({ state: 'connected', missingTools: ['save_issue'] })
  })

  it('a required parameter gone from a tool is reported as tool.param', async () => {
    const { client } = await connected({}, (f) => {
      const all = f.listTools.bind(f)
      f.listTools = async () => (await all()).map((t) => {
        if (t.name !== 'save_issue' && t.name !== 'list_issues') return t
        const schema = structuredClone(t.inputSchema) as { properties: Record<string, unknown> }
        if (t.name === 'save_issue') delete schema.properties.patch
        else delete schema.properties.cursor
        return { ...t, inputSchema: schema }
      })
    })
    expect(client.connection().missingTools).toEqual(['save_issue.patch', 'list_issues.cursor'])
  })

  it('the captured tools have every required parameter', async () => {
    const { client } = await connected()
    expect(client.connection().missingTools).toEqual([])
  })

  it('resume never opens the browser', async () => {
    const fake = fakeLinear()
    const open = vi.fn(async () => fake)
    const client = new LinearClient(open, memoryStore())
    await expect(client.resume()).resolves.toMatchObject({ state: 'connected', workspace: 'canopy' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(false)
  })

  it('resume without stored tokens is disconnected, with refused tokens expired', async () => {
    const none = new LinearClient(async () => { throw new LinearNotConnectedError() }, memoryStore())
    await expect(none.resume()).resolves.toEqual({ state: 'disconnected', missingTools: [] })
    const refused = new LinearClient(async () => { throw new UnauthorizedError() }, memoryStore())
    await expect(refused.resume()).resolves.toEqual({ state: 'expired', missingTools: [] })
  })

  it('resume that cannot reach Linear with stored tokens is offline with the reason, and a later resume connects', async () => {
    const opts: ReplayOptions = { failWith: new Error('fetch failed') }
    const fake = fakeLinear(opts)
    const client = new LinearClient(async () => fake, memoryStore())
    await expect(client.resume()).resolves.toEqual({ state: 'offline', error: 'Linear injoignable : fetch failed', missingTools: [] })
    await expect(client.listMine()).rejects.toBeInstanceOf(LinearOfflineError)
    await expect(client.listMine()).rejects.toThrow('Linear injoignable : fetch failed')
    opts.failWith = undefined
    await expect(client.resume()).resolves.toMatchObject({ state: 'connected', workspace: 'canopy' })
  })

  it('UnauthorizedError expires the connection and throws LinearExpiredError', async () => {
    const opts: ReplayOptions = {}
    const { client } = await connected(opts)
    opts.failWith = new UnauthorizedError()
    await expect(client.listMine()).rejects.toBeInstanceOf(LinearExpiredError)
    expect(client.connection().state).toBe('expired')
    opts.failWith = undefined
    await expect(client.issueBrief('CAN-1')).rejects.toBeInstanceOf(LinearExpiredError)
  })

  it('a 401 from the transport also expires', async () => {
    const opts: ReplayOptions = {}
    const { client } = await connected(opts)
    opts.failWith = Object.assign(new Error('Server returned 401 after successful authentication'), { code: 401 })
    await expect(client.issueBrief('CAN-1')).rejects.toBeInstanceOf(LinearExpiredError)
    expect(client.connection().state).toBe('expired')
  })

  it('other errors leave the connection alone', async () => {
    const opts: ReplayOptions = {}
    const { client } = await connected(opts)
    opts.failWith = new Error('fetch failed')
    await expect(client.listMine()).rejects.toThrow('fetch failed')
    expect(client.connection().state).toBe('connected')
  })

  it('disconnect closes and clears linearAuth', async () => {
    const { client, fake, store } = await connected()
    const close = vi.spyOn(fake, 'close')
    await client.disconnect()
    expect(close).toHaveBeenCalled()
    expect(store.saved).toEqual([null])
    expect(client.connection()).toEqual({ state: 'disconnected', missingTools: [] })
    await expect(client.listMine()).rejects.toBeInstanceOf(LinearNotConnectedError)
  })

  it('reconnecting closes the previous caller', async () => {
    const first = fakeLinear()
    const second = fakeLinear()
    const close = vi.spyOn(first, 'close')
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const client = new LinearClient(open, memoryStore())
    await client.connect()
    await client.connect()
    expect(close).toHaveBeenCalled()
    await client.listMine()
    expect(second.calls.some((c) => c.name === 'list_issues')).toBe(true)
    expect(first.calls.some((c) => c.name === 'list_issues')).toBe(false)
  })

  it('a slow resume never overwrites a newer connect, whether it fails or succeeds', async () => {
    const good = fakeLinear()
    let failResume!: (e: Error) => void
    const open = vi.fn((interactive: boolean): Promise<McpCaller> => interactive
      ? Promise.resolve(good)
      : new Promise((_, reject) => { failResume = reject }))
    const client = new LinearClient(open, memoryStore())
    const resumed = client.resume()
    await expect(client.connect()).resolves.toMatchObject({ state: 'connected' })
    failResume(new UnauthorizedError())
    await expect(resumed).resolves.toMatchObject({ state: 'connected' })
    expect(client.connection().state).toBe('connected')
    await expect(client.issueBrief('CAN-1')).resolves.toMatchObject({ id: 'CAN-1' })

    const late = fakeLinear()
    const lateClose = vi.spyOn(late, 'close')
    let finishResume!: (c: McpCaller) => void
    const open2 = vi.fn((interactive: boolean): Promise<McpCaller> => interactive
      ? Promise.resolve(good)
      : new Promise((resolve) => { finishResume = resolve }))
    const client2 = new LinearClient(open2, memoryStore())
    const resumed2 = client2.resume()
    await client2.connect()
    finishResume(late)
    await resumed2
    expect(lateClose).toHaveBeenCalled()
    await client2.listMine()
    expect(late.calls).toEqual([])
  })
})

describe('LinearClient reads', () => {
  it('listMine follows the cursor', async () => {
    const { client, fake } = await connected({ pageSize: 2 })
    const issues = await client.listMine()
    expect(issues.map((i) => i.id)).toEqual(['CAN-3', 'CAN-2', 'CAN-4', 'CAN-1'])
    const calls = pages(fake.calls, 'list_issues')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ assignee: 'me' })
    expect(calls[0].cursor).toBeUndefined()
    expect(typeof calls[1].cursor).toBe('string')
  })

  it('listMine asks 250 per page and no description: the list never needs one', async () => {
    const { client, fake } = await connected()
    const issues = await client.listMine()
    const [args] = pages(fake.calls, 'list_issues')
    expect(args).toMatchObject({ assignee: 'me', limit: 250 })
    expect(args.fields).toEqual(expect.arrayContaining(['id', 'title', 'status', 'statusType', 'labels', 'assignee', 'assigneeId', 'team', 'teamId', 'url']))
    expect(args.fields).not.toContain('description')
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((i) => i.description === '')).toBe(true)
  })

  it('one refresh of 300 assigned issues takes two list calls', async () => {
    const row = (n: number) => ({
      id: `CAN-${n}`, uuid: `u${n}`, title: `T${n}`, priority: { value: 0, name: 'No priority' }, url: 'https://x',
      updatedAt: '2026-11-08T00:00:00.000Z', status: 'Todo', statusType: 'unstarted', labels: [], assignee: null, assigneeId: null,
      team: 'Canopy', teamId: TEAM,
    })
    const all = Array.from({ length: 300 }, (_, n) => row(n + 1))
    const { client, fake } = await connected({
      mutate: (tool, args) => {
        if (tool !== 'list_issues') return undefined
        const start = typeof args.cursor === 'string' ? Number(args.cursor) : 0
        const limit = Math.min(Number(args.limit ?? 50), 250)
        const more = start + limit < all.length
        return { issues: all.slice(start, start + limit), hasNextPage: more, ...(more ? { cursor: String(start + limit) } : {}) }
      },
    })
    expect(await client.listMine()).toHaveLength(300)
    expect(pages(fake.calls, 'list_issues')).toHaveLength(2)
  })

  it('the description is read with the issue, never from the list', async () => {
    const { client } = await connected()
    const listed = (await client.listMine()).find((i) => i.id === 'CAN-3')
    const brief = await client.issueBrief('CAN-3')
    expect(listed?.description).toBe('')
    expect(brief.description).not.toBe('')
  })

  it('a cursor that does not move is an error, not a loop', async () => {
    const { client } = await connected({
      mutate: (tool) => (tool === 'list_issues' ? { issues: [], hasNextPage: true, cursor: 'same' } : undefined),
    })
    await expect(client.listMine()).rejects.toThrow()
  })

  it('issue reads the detail with every child page and the comments', async () => {
    const child = (n: number) => ({
      id: `CAN-${n}0`, uuid: `u${n}`, title: `Child ${n}`, description: '', priority: { value: 0, name: 'No priority' }, url: 'https://x',
      updatedAt: '2026-11-08T00:00:00.000Z', status: 'Todo', statusType: 'unstarted', labels: [], assignee: null, assigneeId: null,
      team: 'Canopy', teamId: TEAM,
    })
    const { client, fake } = await connected({
      mutate: (tool, args) => {
        if (tool !== 'list_issues' || args.parentId === undefined) return undefined
        return args.cursor === undefined ? { issues: [child(1)], hasNextPage: true, cursor: 'p2' } : { issues: [child(2)], hasNextPage: false }
      },
    })
    const d = await client.issue('CAN-3')
    expect(d.id).toBe('CAN-3')
    expect(d.description).not.toContain('truncated')
    expect(d.children).toEqual([
      { id: 'CAN-10', title: 'Child 1', status: { id: null, name: 'Todo', type: 'unstarted' } },
      { id: 'CAN-20', title: 'Child 2', status: { id: null, name: 'Todo', type: 'unstarted' } },
    ])
    expect(d.comments).toEqual([])
    expect(pages(fake.calls, 'get_issue')[0]).toMatchObject({ id: 'CAN-3' })
    expect((pages(fake.calls, 'get_issue')[0].fields as string[])).toContain('parentId')
    expect(pages(fake.calls, 'list_issues').map((a) => a.parentId)).toEqual(['CAN-3', 'CAN-3'])
    expect(pages(fake.calls, 'list_comments')[0]).toMatchObject({ issueId: 'CAN-3' })
  })

  it('unknown issue is notFound', async () => {
    const { client } = await connected()
    await expect(client.issue('CAN-9999')).rejects.toMatchObject({ name: 'LinearError', notFound: true })
    await expect(client.issueBrief('CAN-9999')).rejects.toMatchObject({ notFound: true })
  })

  it('notFound is only trusted from get_issue', async () => {
    const { client } = await connected({
      mutate: (tool) => (tool === 'save_comment' ? { content: [{ type: 'text', text: 'Entity not found: parent' }], isError: true } : undefined),
    })
    const err = await client.comment('CAN-1', 'hi').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearError)
    expect((err as LinearError).notFound).toBe(false)
  })

  it('issueBrief reads one issue', async () => {
    const { client } = await connected()
    const i = await client.issueBrief('CAN-1')
    expect(i).toMatchObject({ id: 'CAN-1', team: { id: TEAM, name: 'Canopy' }, parentId: null })
  })

  it('teamOptions gives the statuses in order, the labels and the users', async () => {
    const { client, fake } = await connected()
    const o = await client.teamOptions(TEAM)
    expect(o.statuses.map((s) => s.name)).toEqual(['In Review', 'Done', 'Canceled', 'In Progress', 'Todo', 'Duplicate', 'Backlog'])
    expect(o.labels).toEqual(['Improvement', 'Feature', 'Bug'])
    expect(o.users.map((u) => u.name)).toContain('Bastien')
    expect(pages(fake.calls, 'list_issue_statuses')[0]).toEqual({ team: TEAM })
  })
})

describe('LinearClient writes', () => {
  it('save sends the args with the id and returns the saved issue', async () => {
    const { client, fake } = await connected()
    const saved = await client.save('CAN-1', { title: 'Renamed', state: 'In Progress', priority: 2 })
    expect(saved).toMatchObject({ id: 'CAN-1', title: 'Renamed', status: { name: 'In Progress', type: 'started' }, priority: 'high' })
    expect(pages(fake.calls, 'save_issue')[0]).toEqual({ id: 'CAN-1', title: 'Renamed', state: 'In Progress', priority: 2 })
    expect((await client.issueBrief('CAN-1')).title).toBe('Renamed')
  })

  it('createIssue sends save_issue without id, assigned to me, and returns the parsed issue', async () => {
    const { client, fake } = await connected()
    const created = await client.createIssue({ title: 'New one', team: 'Canopy', priority: 'high', parentId: 'CAN-3' })
    expect(pages(fake.calls, 'save_issue')[0]).toEqual({ title: 'New one', team: 'Canopy', assignee: 'me', priority: 2, parentId: 'CAN-3' })
    expect(pages(fake.calls, 'save_issue')[0]).not.toHaveProperty('id')
    expect(created).toMatchObject({ title: 'New one', priority: 'high', status: { type: 'unstarted' } })
    expect((await client.issueBrief(created.id)).title).toBe('New one')
  })

  it('a failed patch is a LinearError and saves nothing', async () => {
    const { client } = await connected()
    const before = await client.issueBrief('CAN-1')
    const err = await client.save('CAN-1', { patch: [{ op: 'replace', old_string: 'no such text anywhere', new_string: 'x' }] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearError)
    expect((err as Error).message).toContain('Patch failed, nothing was saved. Operation 1 (replace)')
    expect((await client.issueBrief('CAN-1')).description).toBe(before.description)
  })

  it('comment posts on the issue and shows in the detail', async () => {
    const { client, fake } = await connected()
    const c = await client.comment('CAN-2', 'Hello **world**')
    expect(c).toMatchObject({ body: 'Hello **world**', author: 'Bastien' })
    expect(pages(fake.calls, 'save_comment')[0]).toEqual({ issueId: 'CAN-2', body: 'Hello **world**' })
    expect((await client.issue('CAN-2')).comments.map((x) => x.body)).toEqual(['Hello **world**'])
  })
})

describe('linearOpener', () => {
  it('without stored tokens, the non-interactive open fails without the browser or the network', async () => {
    const openExternal = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const open = linearOpener({ store: { linearAuth: () => null, saveLinearAuth: () => {} }, openExternal, version: '0.0.0' })
      await expect(open(false)).rejects.toBeInstanceOf(LinearNotConnectedError)
      expect(openExternal).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { fetchSpy.mockRestore() }
  })

  it('a stored state marked expired resumes as expired, without the browser or the network', async () => {
    const openExternal = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const state = { client: { client_id: 'cid', redirect_uris: ['http://localhost:33418/callback'] }, tokens: { access_token: 'at', token_type: 'Bearer' }, expired: true }
      const store = { linearAuth: () => state, saveLinearAuth: vi.fn() }
      const open = linearOpener({ store, openExternal, version: '0.0.0' })
      await expect(open(false)).rejects.toBeInstanceOf(LinearExpiredError)
      const client = new LinearClient(open, store)
      await expect(client.resume()).resolves.toEqual({ state: 'expired', missingTools: [] })
      expect(openExternal).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(store.saveLinearAuth).not.toHaveBeenCalled()
    } finally { fetchSpy.mockRestore() }
  })
})
