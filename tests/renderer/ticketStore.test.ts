import { describe, expect, it } from 'vitest'
import type { Ticket, TicketListEntry, TicketStatus } from '../../src/shared/tickets'
import { groupByStatus, openCount } from '../../src/renderer/tickets/ticketStore'

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
