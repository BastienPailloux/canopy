import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { LinearClient } from '../linear/client'
import type { LinearEdits } from '../linear/edits'
import type { LinearSync } from '../linear/sync'
import type { MockupStore } from '../mockups/store'
import type { TicketStore } from '../tickets/store'
import { TICKET_ID_RE, ticketKey, type Ticket, type TicketKey, type TicketSource } from '../../shared/tickets'
import type { Mockup } from '../../shared/mockups'
import type { LinearIssue } from '../../shared/linear'

export type CanopyToolName = 'list_tickets' | 'get_ticket' | 'list_mockups' | 'create_ticket' | 'update_ticket' | 'link_mockup'

export const WRITE_TOOLS: CanopyToolName[] = ['create_ticket', 'update_ticket', 'link_mockup']

export interface CanopyToolDeps {
  repoRoot: string
  mode: () => PermissionMode
  tickets: Pick<TicketStore, 'list' | 'get' | 'children' | 'create' | 'patch'>
  mockups: Pick<MockupStore, 'list' | 'add' | 'patch'>
  linear: Pick<LinearClient, 'connection' | 'issue' | 'issueBrief' | 'teamOptions' | 'createIssue'>
  edits: Pick<LinearEdits, 'save' | 'pending'>
  sync: Pick<LinearSync, 'state' | 'refresh'>
}

type Args = Record<string, unknown>

const NOT_CONNECTED = "Canopy n'est pas connecté à Linear."
const LINEAR_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/

/** Case- and accent-insensitive form used for searching. */
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Splits `local:CAN-4` / `linear:ENG-482`; the id is checked here because this is the security boundary. */
export function parseKey(key: string): { source: TicketSource; id: string } {
  const m = /^(local|linear):(.+)$/.exec(typeof key === 'string' ? key : '')
  if (!m || !(m[1] === 'local' ? TICKET_ID_RE : LINEAR_ID_RE).test(m[2])) throw new Error(`Clé de ticket invalide : ${key}`)
  return { source: m[1] as TicketSource, id: m[2] }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function isDoneLinear(i: LinearIssue): boolean {
  return i.status.type === 'completed' || i.status.type === 'canceled'
}

function localRow(t: Ticket, children: number) {
  return {
    key: ticketKey('local', t.id), title: t.title, status: t.status, priority: t.priority, labels: t.labels,
    ...(t.parent ? { parent: ticketKey('local', t.parent) } : {}), children,
    ...(t.branch ? { branch: t.branch } : {}),
  }
}

function linearRow(i: LinearIssue) {
  return {
    key: ticketKey('linear', i.id), title: i.title, status: i.status.name, priority: i.priority, labels: i.labels,
    ...(i.parentId ? { parent: ticketKey('linear', i.parentId) } : {}),
  }
}

function mockupRow(m: Mockup) {
  return { id: m.id, title: m.title, url: m.url, kind: m.kind, status: m.status, ...(m.ticket ? { ticket: ticketKey('local', m.ticket) } : {}) }
}

export function createCanopyTools(deps: CanopyToolDeps): Record<CanopyToolName, (args: Args) => Promise<unknown>> {
  const { repoRoot } = deps

  const requireLinear = (): void => {
    if (deps.linear.connection().state !== 'connected') throw new Error(NOT_CONNECTED)
  }

  async function mockupsOf(): Promise<Mockup[]> {
    const list = await deps.mockups.list(repoRoot)
    if (list.kind === 'unreadable') throw new Error(list.error)
    return list.mockups
  }

  async function listTickets(args: Args) {
    const source = str(args.source)
    const query = str(args.query) ? fold(args.query as string) : undefined
    const status = str(args.status)?.toLowerCase()
    const includeDone = args.includeDone === true
    const rows: (ReturnType<typeof localRow> | ReturnType<typeof linearRow>)[] = []
    const unreadable: { file: string; error: string }[] = []
    let linearError: string | undefined

    if (source !== 'linear') {
      const entries = await deps.tickets.list(repoRoot)
      const live = entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : []))
      for (const e of entries) if (e.kind === 'unreadable') unreadable.push({ file: e.file, error: e.error })
      for (const t of live) {
        if (!includeDone && t.status === 'done') continue
        if (status && t.status !== status) continue
        if (query && !fold(`${t.title}\n${t.description}`).includes(query)) continue
        rows.push(localRow(t, live.filter((c) => c.parent === t.id).length))
      }
    }

    if (source !== 'local') {
      if (deps.linear.connection().state !== 'connected') linearError = NOT_CONNECTED
      else {
        for (const i of deps.sync.state().issues) {
          if (!includeDone && isDoneLinear(i)) continue
          if (status && i.status.name.toLowerCase() !== status) continue
          if (query && !fold(`${i.title}\n${i.labels.join('\n')}`).includes(query)) continue
          rows.push(linearRow(i))
        }
      }
    }

    return { tickets: rows, ...(unreadable.length ? { unreadable } : {}), ...(linearError ? { linearError } : {}) }
  }

  async function getLocal(id: string) {
    const t = await deps.tickets.get(repoRoot, id)
    const [kids, all] = await Promise.all([deps.tickets.children(repoRoot, id), mockupsOf()])
    let parent: { key: TicketKey; title?: string; missing?: true } | undefined
    if (t.parent) {
      const key = ticketKey('local', t.parent)
      parent = await deps.tickets.get(repoRoot, t.parent).then((p) => ({ key, title: p.title }), () => ({ key, missing: true as const }))
    }
    return {
      key: ticketKey('local', t.id), title: t.title, description: t.description, status: t.status, priority: t.priority,
      labels: t.labels, subtasks: t.subtasks,
      ...(t.branch ? { branch: t.branch } : {}), ...(t.worktree ? { worktree: t.worktree } : {}), ...(t.base ? { base: t.base } : {}),
      ...(parent ? { parent } : {}),
      children: kids.map((c) => ({ key: ticketKey('local', c.id), title: c.title, status: c.status })),
      mockups: all.filter((m) => m.ticket === t.id).map(({ id: mid, title, url, kind, status }) => ({ id: mid, title, url, kind, status })),
      created: t.created, updated: t.updated,
    }
  }

  async function getLinear(id: string) {
    requireLinear()
    const issue = await deps.linear.issue(id)
    const options = await deps.linear.teamOptions(issue.team.id)
    // Bastien's unsent edit wins: it is what the editor shows, and what a write of Claude builds on.
    const edit = deps.edits.pending().find((p) => p.id === issue.id)?.change
    return {
      key: ticketKey('linear', issue.id), url: issue.url, team: issue.team.name,
      title: edit?.title ?? issue.title,
      description: edit?.description?.text ?? issue.description,
      status: issue.status.name, priority: edit?.priority ?? issue.priority,
      labels: edit?.labels?.next ?? issue.labels,
      assignee: issue.assignee?.name ?? null,
      ...(issue.parentId ? { parent: ticketKey('linear', issue.parentId) } : {}),
      children: issue.children.map((c) => ({ key: ticketKey('linear', c.id), title: c.title, status: c.status.name })),
      statuses: options.statuses.map((s) => s.name), availableLabels: options.labels,
      ...(edit ? { pending: true } : {}),
    }
  }

  async function getTicket(args: Args) {
    const { source, id } = parseKey(args.key as string)
    return source === 'local' ? getLocal(id) : getLinear(id)
  }

  async function listMockups(args: Args) {
    let ticket: string | undefined
    if (args.ticket !== undefined && args.ticket !== null) {
      const k = parseKey(args.ticket as string)
      if (k.source !== 'local') throw new Error('Les maquettes ne se lient qu’à des tickets locaux.')
      ticket = k.id
    }
    const rows = (await mockupsOf()).filter((m) => (ticket ? m.ticket === ticket : true) && (args.unlinked === true ? !m.ticket : true))
    return { mockups: rows.map(mockupRow) }
  }

  // Replaced by the write handlers of the next tasks.
  const unavailable = async (): Promise<never> => { throw new Error('Pas encore disponible') }

  return {
    list_tickets: listTickets,
    get_ticket: getTicket,
    list_mockups: listMockups,
    create_ticket: unavailable,
    update_ticket: unavailable,
    link_mockup: unavailable,
  }
}
