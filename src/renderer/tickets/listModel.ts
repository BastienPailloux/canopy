import { PRIORITY_LABEL, STATUS_LABEL, STATUS_ORDER, ticketKey, type TicketKey, type TicketListEntry, type TicketPriority, type TicketSource, type TicketStatus } from '../../shared/tickets'
import { statusGroup, type LinearIssue, type LinearListState } from '../../shared/linear'

export interface Row {
  key: TicketKey
  source: TicketSource
  id: string
  title: string
  status: TicketStatus
  /** Linear's own status name when it differs from the group label. */
  statusName?: string
  priority: TicketPriority
  labels: string[]
  pending: boolean
}

export interface Filters {
  status: 'all' | TicketStatus
  source: 'all' | TicketSource
  priority: 'all' | TicketPriority
  query: string
}

export const NO_FILTERS: Filters = { status: 'all', source: 'all', priority: 'all', query: '' }

/** Local tickets then Linear issues; issues whose status is hidden (canceled, duplicate) are left out. */
export function mergeRows(local: TicketListEntry[], linear: LinearIssue[], pendingIds: Set<string>): Row[] {
  const rows: Row[] = []
  for (const e of local) {
    if (e.kind !== 'ticket') continue
    const t = e.ticket
    rows.push({ key: ticketKey('local', t.id), source: 'local', id: t.id, title: t.title, status: t.status, priority: t.priority, labels: t.labels, pending: false })
  }
  for (const i of linear) {
    const status = statusGroup(i.status)
    if (!status) continue
    rows.push({
      key: ticketKey('linear', i.id), source: 'linear', id: i.id, title: i.title, status,
      ...(i.status.name !== STATUS_LABEL[status] ? { statusName: i.status.name } : {}),
      priority: i.priority, labels: i.labels, pending: pendingIds.has(i.id)
    })
  }
  return rows
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function filterRows(rows: Row[], f: Filters): Row[] {
  const q = fold(f.query.trim())
  return rows.filter((r) =>
    (f.status === 'all' || r.status === f.status) &&
    (f.source === 'all' || r.source === f.source) &&
    (f.priority === 'all' || r.priority === f.priority) &&
    (!q || fold(r.title).includes(q) || fold(r.id).includes(q)))
}

export function groupRows(rows: Row[]): { status: TicketStatus; rows: Row[] }[] {
  return STATUS_ORDER.map((status) => ({ status, rows: rows.filter((r) => r.status === status) })).filter((g) => g.rows.length > 0)
}

/** Linear tickets not done, for the count next to local open tickets. */
export function openLinearCount(linear: LinearIssue[]): number {
  return linear.filter((i) => { const g = statusGroup(i.status); return g !== null && g !== 'done' }).length
}

export const priorityName = (p: TicketPriority): string => PRIORITY_LABEL[p]

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export function syncLabel(s: LinearListState, now: Date): string {
  if (s.expired) return 'Connexion Linear expirée — Reconnecter'
  const at = s.fetchedAt ? new Date(s.fetchedAt) : null
  if (s.error) return at ? `Linear · liste du ${hhmm(at)} — ${s.error}` : `Linear — ${s.error}`
  if (!at) return 'Linear · pas encore synchronisé'
  const min = Math.floor((now.getTime() - at.getTime()) / 60_000)
  return min < 1 ? 'Linear · synchro à l’instant' : `Linear · synchro il y a ${min} min`
}
