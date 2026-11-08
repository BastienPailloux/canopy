import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket, TicketListEntry, TicketStatus } from '../../src/shared/tickets'
import { connectTickets, groupByStatus, openCount, useTickets } from '../../src/renderer/tickets/ticketStore'
import { useApp } from '../../src/renderer/store'

const t = (id: string, status: TicketStatus): TicketListEntry => ({
  kind: 'ticket',
  ticket: { id, title: id, description: '', status, priority: 'none', labels: [], subtasks: [], created: '', updated: '', archived: false } as Ticket,
})
const bad: TicketListEntry = { kind: 'unreadable', file: 'X.md', error: 'bad' }

describe('openCount', () => {
  it('counts tickets not done, ignoring unreadable files', () => {
    expect(openCount([t('A-1', 'todo'), t('A-2', 'done'), t('A-3', 'backlog'), bad])).toBe(2)
    expect(openCount([])).toBe(0)
  })
})

describe('groupByStatus', () => {
  const entries = [t('A-1', 'done'), t('A-2', 'backlog'), t('A-3', 'in_progress'), t('A-4', 'todo'), t('A-5', 'todo'), bad]

  it('follows STATUS_ORDER, drops empty groups, done last, ignores unreadable', () => {
    const g = groupByStatus(entries, 'all')
    expect(g.map((x) => x.status)).toEqual(['in_progress', 'todo', 'backlog', 'done'])
    expect(g[1].tickets.map((x) => x.id)).toEqual(['A-4', 'A-5'])
  })

  it('filters on one status', () => {
    const g = groupByStatus(entries, 'todo')
    expect(g).toHaveLength(1)
    expect(g[0].status).toBe('todo')
  })

  it('returns nothing for a status without tickets', () => {
    expect(groupByStatus(entries, 'in_review')).toEqual([])
  })
})

describe('connectTickets', () => {
  type Pending = { resolve: (v: TicketListEntry[]) => void; reject: (e: Error) => void }
  let calls: Pending[]
  let changed: (() => void) | null
  let stop: (() => void) | null

  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  beforeEach(() => {
    calls = []
    changed = null
    stop = null
    useTickets.setState({ repo: null, entries: [], error: null, loaded: false })
    useApp.setState({ repo: null })
    vi.stubGlobal('window', {
      canopy: {
        listTickets: () => new Promise<TicketListEntry[]>((resolve, reject) => { calls.push({ resolve, reject }) }),
        watchTickets: async () => undefined,
        on: (event: string, cb: () => void) => { if (event === 'tickets:changed') changed = cb; return () => { changed = null } }
      }
    })
  })
  afterEach(() => { stop?.(); vi.unstubAllGlobals() })

  /** Follows /r, lets the watch settle, then answers every read started so far with `entries`. */
  const start = async (entries: TicketListEntry[]): Promise<void> => {
    useApp.setState({ repo: '/r' })
    stop = connectTickets()
    await flush()
    calls.splice(0).forEach((c) => c.resolve(entries))
    await flush()
  }

  it('is not loaded until the first read answers', async () => {
    useApp.setState({ repo: '/r' })
    stop = connectTickets()
    expect(useTickets.getState().loaded).toBe(false)
    await flush()
    calls.splice(0).forEach((c) => c.resolve([t('A-1', 'todo')]))
    await flush()
    expect(useTickets.getState().loaded).toBe(true)
  })

  it('an older read answering last does not overwrite a newer one', async () => {
    await start([t('A-1', 'todo')])
    changed?.()
    changed?.()
    const [older, newer] = calls.splice(0)
    newer.resolve([t('A-2', 'todo')])
    await flush()
    older.resolve([t('A-1', 'todo')])
    await flush()
    expect(useTickets.getState().entries.map((e) => (e.kind === 'ticket' ? e.ticket.id : e.file))).toEqual(['A-2'])
  })

  it('a failed reload keeps the entries and reports the error', async () => {
    await start([t('A-1', 'todo')])
    changed?.()
    calls.splice(0)[0].reject(new Error('disque plein'))
    await flush()
    const s = useTickets.getState()
    expect(s.entries).toHaveLength(1)
    expect(s.error).toBe('disque plein')
    expect(s.loaded).toBe(true)
  })

  it('a repo switch empties the list until its first read', async () => {
    await start([t('A-1', 'todo')])
    useApp.setState({ repo: '/other' })
    const s = useTickets.getState()
    expect(s).toMatchObject({ repo: '/other', entries: [], loaded: false })
  })
})
