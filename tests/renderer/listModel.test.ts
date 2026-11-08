import { describe, expect, it } from 'vitest'
import type { Ticket, TicketListEntry } from '../../src/shared/tickets'
import type { LinearIssue, LinearListState } from '../../src/shared/linear'
import { filterRows, groupRows, mergeRows, syncLabel, type Filters } from '../../src/renderer/tickets/listModel'

const local = (id: string, title = id, priority: Ticket['priority'] = 'none', status: Ticket['status'] = 'todo'): TicketListEntry => ({
  kind: 'ticket',
  ticket: { id, title, description: '', status, priority, labels: [], subtasks: [], created: '', updated: '', archived: false } as Ticket
})
const issue = (id: string, name = 'En cours', type: LinearIssue['status']['type'] = 'started', title = id, priority: LinearIssue['priority'] = 'none'): LinearIssue => ({
  id, uuid: id, title, description: '', url: '', status: { id: null, name, type }, priority, labels: ['x'], assignee: null,
  team: { id: 't', name: 'T' }, parentId: null, cycle: null, project: null, updatedAt: ''
})
const all: Filters = { status: 'all', source: 'all', priority: 'all', query: '' }

describe('mergeRows', () => {
  it('local and linear CAN-7 stay distinct', () => {
    const rows = mergeRows([local('CAN-7')], [issue('CAN-7')], new Set())
    expect(rows.map((r) => r.key)).toEqual(['local:CAN-7', 'linear:CAN-7'])
  })
  it('QA lands in in_review with its name', () => {
    const [r] = mergeRows([], [issue('A-1', 'QA')], new Set())
    expect(r.status).toBe('in_review')
    expect(r.statusName).toBe('QA')
  })
  it('no statusName when equal to the group label', () => {
    expect(mergeRows([], [issue('A-1', 'En cours')], new Set())[0].statusName).toBeUndefined()
  })
  it('hides canceled issues, flags pending, skips unreadable', () => {
    const rows = mergeRows([{ kind: 'unreadable', file: 'x', error: 'e' }], [issue('A-1', 'Annulé', 'canceled'), issue('A-2')], new Set(['A-2']))
    expect(rows.map((r) => [r.key, r.pending])).toEqual([['linear:A-2', true]])
  })
})

describe('filterRows', () => {
  const rows = mergeRows([local('L-1', 'Local', 'high')], [
    issue('ENG-482', 'En cours', 'started', 'Export CSV des Factures', 'high'), issue('ENG-1', 'En cours', 'started', 'Autre')
  ], new Set())
  it('source', () => expect(filterRows(rows, { ...all, source: 'linear' }).every((r) => r.source === 'linear')).toBe(true))
  it('priority', () => expect(filterRows(rows, { ...all, priority: 'high' }).map((r) => r.id)).toEqual(['L-1', 'ENG-482']))
  it('query on title, accent and case insensitive', () => expect(filterRows(rows, { ...all, query: 'facture' }).map((r) => r.id)).toEqual(['ENG-482']))
  it('query on id', () => expect(filterRows(rows, { ...all, query: 'eng-48' }).map((r) => r.id)).toEqual(['ENG-482']))
  it('status', () => expect(filterRows(rows, { ...all, status: 'todo' }).map((r) => r.id)).toEqual(['L-1']))
})

describe('groupRows', () => {
  it('follows STATUS_ORDER and drops empty groups', () => {
    const rows = mergeRows([local('A', 'A', 'none', 'done'), local('B', 'B', 'none', 'todo')], [issue('C')], new Set())
    expect(groupRows(rows).map((g) => g.status)).toEqual(['in_progress', 'todo', 'done'])
  })
})

describe('syncLabel', () => {
  const base: LinearListState = { issues: [], fetchedAt: '2026-11-08T14:00:00', error: null, expired: false, departures: [] }
  const now = new Date('2026-11-08T14:01:10')
  it('minutes', () => expect(syncLabel(base, now)).toBe('Linear · synchro il y a 1 min'))
  it('just now', () => expect(syncLabel(base, new Date('2026-11-08T14:00:20'))).toBe('Linear · synchro à l’instant'))
  it('error', () => expect(syncLabel({ ...base, fetchedAt: '2026-11-08T14:02:00', error: 'réseau' }, now)).toBe('Linear · liste du 14:02 — réseau'))
  it('expired', () => expect(syncLabel({ ...base, expired: true }, now)).toBe('Connexion Linear expirée — Reconnecter'))
  it('never synced', () => expect(syncLabel({ ...base, fetchedAt: null }, now)).toBe('Linear · pas encore synchronisé'))
})
