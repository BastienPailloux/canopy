import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mockup, MockupList } from '../../src/shared/mockups'
import type { Ticket } from '../../src/shared/tickets'
import type { Worktree } from '../../src/shared/types'
import {
  attachToSession, connectMockups, filterMockups, launchFromMockup, linkedTicket, relativeTime, sessionTarget, useMockups
} from '../../src/renderer/mockups/mockupStore'
import { useSessions } from '../../src/renderer/sessions/sessionStore'
import { useApp } from '../../src/renderer/store'

const mk = (id: string, ticket?: string): Mockup => ({
  id: id.padEnd(22, 'x'), url: `https://claude.ai/artifact/${id.padEnd(22, 'x')}`, title: id, kind: 'web', status: 'todo',
  ...(ticket ? { ticket } : {}), added: '2026-11-08T10:00:00Z', updated: '2026-11-08T10:00:00Z'
})
const tk = (id: string, o: Partial<Ticket> = {}): Ticket => ({
  id, title: id, description: '', status: 'todo', priority: 'none', labels: [], subtasks: [], created: '', updated: '', archived: false, ...o
})

const tickets = [tk('A-1', { branch: 'feat/a' }), tk('A-2', { branch: 'feat/b' }), tk('A-3', { archived: true, branch: 'feat/a' })]
const list = [mk('one', 'A-1'), mk('two', 'A-2'), mk('three'), mk('four', 'A-3'), mk('five', 'GONE-9')]
const titles = (ms: Mockup[]): string[] => ms.map((m) => m.title)

describe('linkedTicket', () => {
  it('is the ticket while it exists and is not archived', () => {
    expect(linkedTicket(mk('a', 'A-1'), tickets)?.id).toBe('A-1')
    expect(linkedTicket(mk('a', 'A-3'), tickets)).toBeUndefined()
    expect(linkedTicket(mk('a', 'GONE-9'), tickets)).toBeUndefined()
    expect(linkedTicket(mk('a'), tickets)).toBeUndefined()
  })
})

describe('filterMockups', () => {
  it('all keeps everything, in order', () => {
    expect(titles(filterMockups(list, 'all', { tickets, branch: null }))).toEqual(['one', 'two', 'three', 'four', 'five'])
  })
  it('worktree keeps mockups whose live ticket is on the active branch', () => {
    expect(titles(filterMockups(list, 'worktree', { tickets, branch: 'feat/a' }))).toEqual(['one'])
    expect(titles(filterMockups(list, 'worktree', { tickets, branch: 'feat/b' }))).toEqual(['two'])
    expect(filterMockups(list, 'worktree', { tickets, branch: null })).toEqual([])
    expect(filterMockups(list, 'worktree', { tickets, branch: 'main' })).toEqual([])
  })
  it('noTicket counts an archived or missing ticket as none', () => {
    expect(titles(filterMockups(list, 'noTicket', { tickets, branch: null }))).toEqual(['three', 'four', 'five'])
  })
})

describe('sessionTarget', () => {
  const wts: Worktree[] = [
    { path: '/r', branch: 'main', head: 'a', isMain: true },
    { path: '/r/.worktrees/a', branch: 'feat/a', head: 'b', isMain: false }
  ]
  it('is the worktree of the ticket branch, else the active worktree', () => {
    expect(sessionTarget(tickets[0], wts, '/r')).toBe('/r/.worktrees/a')
    expect(sessionTarget(tickets[1], wts, '/r')).toBe('/r')
    expect(sessionTarget(undefined, wts, null)).toBeNull()
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const ago = (ms: number): string => relativeTime(new Date(now - ms).toISOString(), now)
  it('speaks French', () => {
    expect(ago(10_000)).toBe('à l’instant')
    expect(ago(5 * 60_000)).toBe('il y a 5 min')
    expect(ago(2 * 3600_000)).toBe('il y a 2 h')
    expect(ago(30 * 3600_000)).toBe('hier')
    expect(ago(3 * 86400_000)).toBe('il y a 3 j')
    expect(ago(8 * 86400_000)).toBe('il y a 1 sem.')
    expect(ago(65 * 86400_000)).toBe('il y a 2 mois')
    expect(ago(400 * 86400_000)).toBe('il y a 1 an')
    expect(relativeTime('nope', now)).toBe('')
  })
})

describe('connectMockups', () => {
  let answers: { resolve: (v: MockupList) => void; reject: (e: Error) => void }[]
  let changed: (() => void) | null
  let stop: (() => void) | null = null
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  beforeEach(() => {
    answers = []
    changed = null
    useMockups.setState({ repo: null, list: [], error: null, loaded: false })
    useApp.setState({ repo: null })
    vi.stubGlobal('window', {
      canopy: {
        listMockups: () => new Promise<MockupList>((resolve, reject) => { answers.push({ resolve, reject }) }),
        watchMockups: async () => undefined,
        on: (event: string, cb: () => void) => { if (event === 'mockups:changed') changed = cb; return () => { changed = null } }
      }
    })
  })
  afterEach(() => { stop?.(); stop = null; vi.unstubAllGlobals() })

  it('loads the active repo, reports an unreadable registry, keeps the list when a read rejects', async () => {
    useApp.setState({ repo: '/r' })
    stop = connectMockups()
    expect(useMockups.getState()).toMatchObject({ repo: '/r', loaded: false })
    await flush()
    // The read again once watching is the one that counts.
    expect(answers).toHaveLength(2)
    answers[1].resolve({ kind: 'ok', mockups: [mk('one')] })
    await flush()
    expect(useMockups.getState()).toMatchObject({ list: [mk('one')], error: null, loaded: true })

    changed?.()
    await flush()
    answers.at(-1)!.reject(new Error('.mockups est suivi par git'))
    await flush()
    expect(useMockups.getState()).toMatchObject({ list: [mk('one')], error: '.mockups est suivi par git' })

    changed?.()
    await flush()
    answers.at(-1)!.resolve({ kind: 'unreadable', error: 'mockups.json illisible : x' })
    await flush()
    expect(useMockups.getState()).toMatchObject({ list: [], error: 'mockups.json illisible : x' })
  })

  it('a repo switch empties the list; a late answer of the repo left is dropped', async () => {
    useApp.setState({ repo: '/r' })
    stop = connectMockups()
    useApp.setState({ repo: '/s' })
    expect(useMockups.getState()).toMatchObject({ repo: '/s', list: [], loaded: false })
    answers[0].resolve({ kind: 'ok', mockups: [mk('old')] })
    await flush()
    expect(useMockups.getState().list).toEqual([])
  })
})

describe('attachToSession', () => {
  beforeEach(() => {
    useSessions.setState({ tabs: {}, active: {}, permissions: [], summaries: {} })
    useApp.setState({ view: 'mockups', worktree: '/r' })
  })

  it('creates a tab if needed, appends the line to its draft, shows Sessions on that worktree', () => {
    attachToSession('/r/.worktrees/a', 'Maquette : A — u')
    const s = useSessions.getState()
    const id = s.active['/r/.worktrees/a']
    expect(s.tabs[id].draft.text).toBe('Maquette : A — u')
    attachToSession('/r/.worktrees/a', 'Maquette : B — v')
    expect(useSessions.getState().tabs[id].draft.text).toBe('Maquette : A — u\nMaquette : B — v')
    expect(useApp.getState()).toMatchObject({ view: 'sessions', worktree: '/r/.worktrees/a' })
  })
})

describe('launchFromMockup', () => {
  let createTicket: ReturnType<typeof vi.fn>
  let patchMockup: ReturnType<typeof vi.fn>
  beforeEach(() => {
    useApp.setState({ repo: '/r', view: 'mockups', openTicket: 'local:X', selectedTicket: null })
    useMockups.setState({ repo: '/r', list: [mk('one')], error: null, loaded: true })
    createTicket = vi.fn(async () => tk('A-9'))
    patchMockup = vi.fn(async (_r: string, id: string, c: { ticket: string }) => ({ ...mk('one'), id, ticket: c.ticket }))
    vi.stubGlobal('window', { canopy: { createTicket, patchMockup } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('with a ticket, opens its launch panel', async () => {
    await launchFromMockup('/r', mk('one', 'A-1'), tickets[0])
    expect(createTicket).not.toHaveBeenCalled()
    expect(useApp.getState()).toMatchObject({ view: 'tickets', selectedTicket: 'local:A-1', openTicket: null })
  })

  it('without, creates a Backlog ticket titled like the mockup, links it, then opens its launch panel', async () => {
    const m = mk('one')
    await launchFromMockup('/r', m, undefined)
    expect(createTicket).toHaveBeenCalledWith('/r', expect.objectContaining({ title: 'one', status: 'backlog' }))
    expect(patchMockup).toHaveBeenCalledWith('/r', m.id, { ticket: 'A-9' })
    expect(useMockups.getState().list[0].ticket).toBe('A-9')
    expect(useApp.getState()).toMatchObject({ view: 'tickets', selectedTicket: 'local:A-9', openTicket: null })
  })
})
