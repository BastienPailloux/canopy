import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { LinearClient } from '../linear/client'
import type { LinearEdits } from '../linear/edits'
import type { LinearSync } from '../linear/sync'
import type { MockupStore } from '../mockups/store'
import type { TicketStore } from '../tickets/store'
import { parseFields } from '../tickets/ticketIpc'
import { STATUSES, TICKET_ID_RE, ticketKey, type Ticket, type TicketKey, type TicketSource } from '../../shared/tickets'
import { MOCKUP_ID_RE, MOCKUP_STATUSES, parseArtifactUrl, type Mockup, type MockupStatus } from '../../shared/mockups'
import { LINEAR_ID_RE, LINEAR_MAX_LABEL, LINEAR_MAX_LABELS, LINEAR_MAX_TITLE, type LinearChange, type LinearIssue, type SaveResult } from '../../shared/linear'
import { LinearFormatError } from '../linear/parse'

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

/** Case- and accent-insensitive form used for searching. */
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Splits `local:CAN-4` / `linear:ENG-482`; the id is checked here because this is the security boundary. */
export function parseKey(key: string): { source: TicketSource; id: string } {
  const m = /^(local|linear):(.+)$/.exec(typeof key === 'string' ? key : '')
  // The edit queue is keyed by the exact identifier, so a Linear id is upper-cased before it is used anywhere.
  const id = m && m[1] === 'linear' ? m[2].toUpperCase() : m?.[2]
  if (!m || !id || !(m[1] === 'local' ? TICKET_ID_RE : LINEAR_ID_RE).test(id)) throw new Error(`Clé de ticket invalide : ${key}`)
  return { source: m[1] as TicketSource, id }
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
  /** Linear issues created by this instance, one per session: Claude may edit them before the list knows them. */
  const created = new Set<string>()

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
    // A status filter names what Claude wants: done or canceled tickets included.
    const includeDone = args.includeDone === true || status !== undefined
    const rows: (ReturnType<typeof localRow> | ReturnType<typeof linearRow>)[] = []
    const unreadable: { file: string; error: string }[] = []
    let linearError: string | undefined

    if (source !== 'linear') {
      const entries = await deps.tickets.list(repoRoot)
      const live = entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : []))
      for (const e of entries) if (e.kind === 'unreadable') unreadable.push({ file: e.file, error: e.error })
      const children = new Map<string, number>()
      for (const t of live) if (t.parent) children.set(t.parent, (children.get(t.parent) ?? 0) + 1)
      for (const t of live) {
        if (!includeDone && t.status === 'done') continue
        if (status && t.status !== status) continue
        if (query && !fold(`${t.title}\n${t.description}`).includes(query)) continue
        rows.push(localRow(t, children.get(t.id) ?? 0))
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
    // An unreadable registry must not hide the ticket itself.
    let all: Mockup[] = []
    let mockupsError: string | undefined
    const [kids] = await Promise.all([
      deps.tickets.children(repoRoot, id),
      mockupsOf().then((m) => { all = m }, (e) => { mockupsError = e instanceof Error ? e.message : String(e) }),
    ])
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
      ...(mockupsError ? { mockupsError } : {}),
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

  /** Refuses writes while the session is in plan mode; read at each call because the mode can change mid-session. */
  const guarded = (fn: (args: Args) => Promise<unknown>) => async (args: Args): Promise<unknown> => {
    if (deps.mode() === 'plan') throw new Error('Mode plan : Canopy ne modifie rien tant que la session est en mode plan.')
    return fn(args)
  }

  const checkStatus = (v: unknown): void => {
    if (v !== undefined && !STATUSES.includes(v as never)) throw new Error(`Statut inconnu : ${String(v)}. Statuts possibles : ${STATUSES.join(', ')}`)
  }

  /** Id of a local parent given as a key; null/undefined pass through. */
  function localParent(v: unknown): string | null | undefined {
    if (v === undefined || v === null) return v
    const k = parseKey(v as string)
    if (k.source !== 'local') throw new Error('Le parent doit venir de la même source que le ticket.')
    return k.id
  }

  function fieldsOf(args: Args): Record<string, unknown> {
    const raw: Record<string, unknown> = {}
    for (const k of ['title', 'description', 'status', 'priority', 'labels']) if (args[k] !== undefined) raw[k] = args[k]
    return raw
  }

  /** `statusId` of the status named `name` (any case) in the team's workflow. */
  async function linearStatus(teamId: string, name: string): Promise<string> {
    const { statuses } = await deps.linear.teamOptions(teamId)
    const s = statuses.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!s) throw new Error(`Statut inconnu : ${name}. Statuts possibles : ${statuses.map((x) => x.name).join(', ')}`)
    return s.id
  }

  /** Title and labels follow Linear's limits (as in linearIpc), the rest the local ones; the status is a Linear status name. */
  function linearFields(args: Args): { f: Partial<Pick<Ticket, 'title' | 'description' | 'priority' | 'labels'>>; status?: string } {
    const { status, ...rest } = fieldsOf(args)
    if (status !== undefined && (typeof status !== 'string' || status.trim() === '')) throw new Error('Statut invalide')
    const { title, labels, ...others } = rest
    if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > LINEAR_MAX_TITLE)) throw new Error('Titre invalide')
    if (labels !== undefined && (!Array.isArray(labels) || labels.length > LINEAR_MAX_LABELS ||
      labels.some((l) => typeof l !== 'string' || l === '' || l.length > LINEAR_MAX_LABEL))) throw new Error('Étiquette invalide')
    const f = { ...parseFields(others), ...(title !== undefined ? { title: title as string } : {}), ...(labels !== undefined ? { labels: labels as string[] } : {}) }
    return { f, ...(status !== undefined ? { status: status as string } : {}) }
  }

  /**
   * Team of a new issue: the parent's, else the only team of Bastien's issues, else the one Claude named among them.
   * With no known team (no assigned issue) the name goes to Linear as is: it is the only one able to check it.
   */
  function linearTeam(name: unknown): string {
    const teams = [...new Map(deps.sync.state().issues.map((i) => [i.team.id, i.team])).values()]
    const named = str(name)
    if (named && teams.length === 0) return named
    const known = named ? teams.find((t) => t.name.toLowerCase() === named.toLowerCase()) : undefined
    if (known) return known.id
    if (named === undefined && teams.length === 1) return teams[0].id
    throw new Error(teams.length ? `Précise l'équipe Linear : ${teams.map((t) => t.name).join(', ')}` : "Précise l'équipe Linear.")
  }

  // Not queued: the queue only knows edits of an existing issue, so offline the creation fails with its reason.
  async function createLinear(args: Args) {
    requireLinear()
    const { f, status } = linearFields(args)
    if (typeof f.title !== 'string') throw new Error('Titre invalide')
    let parentId: string | undefined
    if (args.parent !== undefined && args.parent !== null) {
      const k = parseKey(args.parent as string)
      if (k.source !== 'linear') throw new Error('Le parent doit venir de la même source que le ticket.')
      parentId = k.id
    }
    const team = parentId ? (await deps.linear.issueBrief(parentId)).team.id : linearTeam(args.team)
    const state = status !== undefined ? await linearStatus(team, status) : undefined
    let issue: { id: string }
    try {
      issue = await deps.linear.createIssue({
        title: f.title, team,
        ...(f.description ? { description: f.description } : {}),
        ...(parentId ? { parentId } : {}),
        ...(f.priority ? { priority: f.priority } : {}),
        ...(f.labels?.length ? { labels: f.labels } : {}),
        ...(state !== undefined ? { state } : {}),
      })
    } catch (e) {
      if (!(e instanceof LinearFormatError)) throw e
      // Linear has probably created the issue: failing would make Claude retry and duplicate it.
      await deps.sync.refresh().catch(() => undefined)
      return { result: 'créé, mais la réponse de Linear est illisible : vérifie avec list_tickets avant de recréer' }
    }
    created.add(issue.id.toUpperCase())
    // The list is what Claude searches next: it must hold the new issue.
    await deps.sync.refresh().catch(() => undefined)
    return { key: ticketKey('linear', issue.id) }
  }

  function saveResult(r: SaveResult): { result: string } {
    if (r.kind === 'sent') return { result: 'enregistré' }
    if (r.kind === 'pending') return { result: `en attente : ${r.reason}` }
    return { result: "conflit avec une modification d'un collègue : la description n'a pas été envoyée" }
  }

  /**
   * Always through `LinearEdits.save`, like the editor: the description leaves as `patch` ops and the queue survives a
   * failure. Bastien's unsent edit is the base, so `merge` chains Claude's edit onto it instead of replacing it.
   */
  async function updateLinear(id: string, args: Args) {
    requireLinear()
    // A prompt-injected Claude must not write the repo's content into any issue of the workspace with no prompt.
    if (!created.has(id) && !deps.sync.state().issues.some((i) => i.id.toUpperCase() === id)) {
      throw new Error(`Canopy ne modifie que tes tickets Linear assignés et ceux créés dans cette session : ${id}`)
    }
    if (args.parent !== undefined) throw new Error("Le parent d'un ticket Linear existant ne se change pas depuis Canopy.")
    const { f, status } = linearFields(args)
    if (Object.keys(f).length === 0 && status === undefined) throw new Error('Rien à modifier.')
    const queued = deps.edits.pending().find((p) => p.id === id)?.change
    let brief: Promise<LinearIssue> | undefined
    const fresh = (): Promise<LinearIssue> => (brief ??= deps.linear.issueBrief(id))
    const change: LinearChange = {}
    if (f.title !== undefined) change.title = f.title
    if (f.priority !== undefined) change.priority = f.priority
    if (f.description !== undefined) {
      change.description = { base: queued?.description?.text ?? (await fresh()).description, text: f.description }
    }
    if (f.labels !== undefined) change.labels = { base: queued?.labels?.next ?? (await fresh()).labels, next: f.labels }
    if (status !== undefined) change.statusId = await linearStatus((await fresh()).team.id, status)
    return saveResult(await deps.edits.save(id, change))
  }

  async function createTicket(args: Args) {
    if (args.source === 'linear') return createLinear(args)
    if (args.source !== 'local') throw new Error('Source inconnue : local ou linear attendu.')
    checkStatus(args.status)
    const parent = localParent(args.parent)
    const f = parseFields({ ...fieldsOf(args), ...(parent ? { parent } : {}) })
    if (typeof f.title !== 'string') throw new Error('Titre invalide')
    const t = await deps.tickets.create(repoRoot, { description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [], ...f, title: f.title })
    return { key: ticketKey('local', t.id) }
  }

  async function updateTicket(args: Args) {
    const { source, id } = parseKey(args.key as string)
    if (source === 'linear') return updateLinear(id, args)
    checkStatus(args.status)
    const parent = localParent(args.parent)
    const changes = parseFields(fieldsOf(args))
    if (parent === null) changes.parent = undefined
    else if (parent !== undefined) changes.parent = parent
    if (Object.keys(changes).length === 0) throw new Error('Rien à modifier.')
    await deps.tickets.patch(repoRoot, id, changes)
    return { key: ticketKey('local', id) }
  }

  async function linkMockup(args: Args) {
    const ref = typeof args.mockup === 'string' ? args.mockup.trim() : ''
    const parsed = parseArtifactUrl(ref)
    const id = parsed?.id ?? (MOCKUP_ID_RE.test(ref) ? ref : undefined)
    if (!id) throw new Error(`Maquette invalide : ${String(args.mockup)}`)
    let ticket: string | null | undefined
    if (args.ticket === null) ticket = null
    else if (args.ticket !== undefined) {
      const k = parseKey(args.ticket as string)
      if (k.source !== 'local') throw new Error("Une maquette ne se lie qu'à un ticket local.")
      await deps.tickets.get(repoRoot, k.id)
      ticket = k.id
    }
    if (args.status !== undefined && !MOCKUP_STATUSES.includes(args.status as MockupStatus)) {
      throw new Error(`Statut de maquette inconnu : ${String(args.status)}. Statuts possibles : ${MOCKUP_STATUSES.join(', ')}`)
    }
    if (ticket === undefined && args.status === undefined) throw new Error('Rien à modifier.')
    const added = parsed !== null && !(await mockupsOf()).some((m) => m.id === id)
    if (parsed) await deps.mockups.add(repoRoot, parsed.url)
    try {
      const m = await deps.mockups.patch(repoRoot, id, {
        ...(ticket !== undefined ? { ticket } : {}),
        ...(args.status !== undefined ? { status: args.status as MockupStatus } : {}),
      })
      return mockupRow(m)
    } catch (e) {
      // Claude would otherwise believe nothing changed and add it again elsewhere.
      if (added) throw new Error(`Maquette ajoutée mais non liée : ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }

  return {
    list_tickets: listTickets,
    get_ticket: getTicket,
    list_mockups: listMockups,
    create_ticket: guarded(createTicket),
    update_ticket: guarded(updateTicket),
    link_mockup: guarded(linkMockup),
  }
}
