import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue, LinearListState } from '../../src/shared/linear'
import { connectLinear, refreshLinear, reloadLinearLinks, useLinear } from '../../src/renderer/tickets/linearStore'
import { useApp } from '../../src/renderer/store'

const issue = { id: 'A-1', title: 'a', status: { id: null, name: 'En cours', type: 'started' }, priority: 'none', labels: [] } as unknown as LinearIssue
const list = (over: Partial<LinearListState> = {}): LinearListState => ({ issues: [issue], fetchedAt: '2026-11-08T10:00:00', error: null, expired: false, departures: [], kept: [], ...over })

describe('connectLinear', () => {
  let changed: ((payload?: unknown) => void) | null
  let stop: (() => void) | null
  let refresh: ReturnType<typeof vi.fn>
  let listFn: ReturnType<typeof vi.fn>
  const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

  beforeEach(() => {
    vi.useFakeTimers()
    changed = null
    stop = null
    refresh = vi.fn(async () => list())
    listFn = vi.fn(async () => list())
    useLinear.setState({ connection: { state: 'disconnected', missingTools: [] }, list: list({ issues: [], fetchedAt: null }), pending: [], links: {} })
    useApp.setState({ repo: '/r', view: 'tickets' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      canopy: {
        linearConnection: async () => ({ state: 'connected', missingTools: [] }),
        linearList: listFn, linearRefresh: refresh, linearPending: async () => [], linearLinks: async () => ({}),
        on: (e: string, cb: (payload?: unknown) => void) => { if (e === 'linear:changed') changed = cb; return () => { changed = null } }
      }
    })
  })
  afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('loads on start', async () => {
    stop = connectLinear()
    await flush()
    expect(useLinear.getState().connection.state).toBe('connected')
    expect(useLinear.getState().list.issues).toHaveLength(1)
  })

  it('refreshes every 180 s while on Tickets, and stops when leaving', async () => {
    stop = connectLinear()
    await flush()
    refresh.mockClear()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    useApp.setState({ view: 'sessions' })
    refresh.mockClear()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('linear:changed re-reads without refreshing', async () => {
    stop = connectLinear()
    await flush()
    refresh.mockClear()
    listFn.mockClear()
    changed?.()
    await flush()
    expect(listFn).toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a failed refresh keeps the issues', async () => {
    stop = connectLinear()
    await flush()
    refresh.mockRejectedValueOnce(new Error('réseau'))
    await vi.advanceTimersByTimeAsync(180_000)
    const l = useLinear.getState().list
    expect(l.issues).toHaveLength(1)
    expect(l.error).toBe('réseau')
  })

  it('two triggers share one linearRefresh call', async () => {
    stop = connectLinear()
    await flush()
    refresh.mockClear()
    const a = refreshLinear()
    const b = refreshLinear()
    await Promise.all([a, b])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a refresh of repo A answering after a switch to B is ignored', async () => {
    stop = connectLinear()
    await flush()
    let resolveA!: (l: LinearListState) => void
    refresh.mockImplementationOnce(() => new Promise<LinearListState>((r) => { resolveA = r }))
    const p = refreshLinear()
    useApp.setState({ repo: '/other' })
    await flush()
    resolveA(list({ issues: [], fetchedAt: 'A' }))
    await p
    expect(useLinear.getState().list.fetchedAt).not.toBe('A')
  })

  it('a repo switch resets links, and a failed read leaves them empty', async () => {
    const links = { 'A-1': { branch: 'b', worktree: 'w', base: 'x' } }
    ;(window as any).canopy.linearLinks = vi.fn(async () => links)
    stop = connectLinear()
    await flush()
    expect(useLinear.getState().links).toEqual(links)
    ;(window as any).canopy.linearLinks = vi.fn(async () => { throw new Error('x') })
    useApp.setState({ repo: '/other' })
    await flush()
    expect(useLinear.getState().links).toEqual({})
  })

  it('an event naming issues re-reads the list without the branch listing, and the links only for a linked issue', async () => {
    const links = { 'A-1': { branch: 'b', worktree: 'w', base: 'x' } }
    const linksFn = vi.fn(async () => links)
    ;(window as any).canopy.linearLinks = linksFn
    stop = connectLinear()
    await flush()
    listFn.mockClear(); linksFn.mockClear()
    changed?.({ ids: ['B-7'] })
    await flush()
    expect(listFn).toHaveBeenCalledWith('/r', false)
    expect(linksFn).not.toHaveBeenCalled()
    changed?.({ ids: ['A-1'] })
    await flush()
    expect(linksFn).toHaveBeenCalledTimes(1)
    listFn.mockClear(); linksFn.mockClear()
    changed?.({})
    await flush()
    expect(listFn).toHaveBeenCalledWith('/r')
    expect(linksFn).toHaveBeenCalledTimes(1)
  })

  it('focus refreshes only when the last good sync is 30 s old or more', async () => {
    vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'))
    const fresh = async () => list({ fetchedAt: '2026-11-08T09:59:50.000Z' })
    listFn.mockImplementation(fresh)
    refresh.mockImplementation(fresh)
    stop = connectLinear()
    await flush()
    const onFocus = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'focus')?.[1] as () => void
    refresh.mockClear()
    onFocus()
    await flush()
    expect(refresh).not.toHaveBeenCalled()
    vi.setSystemTime(new Date('2026-11-08T10:00:21.000Z'))
    onFocus()
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reloadLinearLinks reads the links of the followed repo', async () => {
    const linksFn = vi.fn(async () => ({}))
    ;(window as any).canopy.linearLinks = linksFn
    stop = connectLinear()
    await flush()
    linksFn.mockClear()
    await reloadLinearLinks()
    expect(linksFn).toHaveBeenCalledWith('/r')
  })
})
