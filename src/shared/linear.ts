import { branchSlug, type LaunchTarget, type TicketPriority, type TicketStatus } from './tickets'

export type LinearStatusType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'

/** A status of a team's workflow. */
export interface LinearStatus { id: string; name: string; type: LinearStatusType }

export interface LinearUser { id: string; name: string }

export interface LinearIssue {
  /** Human identifier, e.g. ENG-482. */
  id: string
  uuid: string
  title: string
  description: string
  url: string
  /** Issue answers carry no status id. */
  status: { id: string | null; name: string; type: LinearStatusType }
  priority: TicketPriority
  labels: string[]
  assignee: LinearUser | null
  team: { id: string; name: string }
  parentId: string | null
  /** Display only. */
  cycle: string | null
  /** Display only. */
  project: string | null
  updatedAt: string
}

/** Where a launched Linear issue lives; kept in Canopy's own state, never in Linear. */
export interface LinearLink { branch: string; worktree: string; base: string }

export interface LinearComment { id: string; author: string; body: string; createdAt: string }

export interface LinearIssueDetail extends LinearIssue {
  children: Pick<LinearIssue, 'id' | 'title' | 'status'>[]
  comments: LinearComment[]
}

export const LINEAR_NOTICE = 'Claude n’a pas accès à Linear dans cette session.'

/** Whether a connected MCP server of a session's init message is Linear's. */
export function hasLinearServer(servers: { name: string; status: string }[]): boolean {
  return servers.some((s) => s.status === 'connected' && s.name.toLowerCase().includes('linear'))
}

export const LINEAR_MCP_NOTE = 'Le reste du ticket (commentaires, sous-tickets, pièces jointes) est accessible via le MCP Linear.'

/** Canopy status group of a Linear status; null = hidden. */
export function statusGroup(s: Pick<LinearStatus, 'name' | 'type'>): TicketStatus | null {
  switch (s.type) {
    case 'triage':
    case 'backlog': return 'backlog'
    case 'unstarted': return 'todo'
    case 'started': return /review|revue|qa/i.test(s.name) ? 'in_review' : 'in_progress'
    case 'completed': return 'done'
    default: return null
  }
}

/**
 * The group a Linear issue is listed in, in main's list and on screen alike; null = not listed. `kept`: launched, or with
 * an unsent edit: listed whatever its status, a hidden status (canceled, duplicate) in Terminé with its own name.
 */
export function listGroup(s: Pick<LinearStatus, 'name' | 'type'>, kept: boolean): TicketStatus | null {
  return statusGroup(s) ?? (kept ? 'done' : null)
}

const PRIORITIES_BY_VALUE: TicketPriority[] = ['none', 'urgent', 'high', 'medium', 'low']

export function priorityFromValue(v: number): TicketPriority {
  return PRIORITIES_BY_VALUE[v] ?? 'none'
}

/** `<type>/<identifier lowercased>-<slug>`; not Linear's own gitBranchName. */
export function linearBranchName(issue: Pick<LinearIssue, 'id' | 'title'>, type = 'feat'): string {
  return `${type}/${issue.id.toLowerCase()}-${branchSlug(issue.title)}`
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch { return null }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Linear's `<linear-image>` and `<linear-embed>` tags as plain Markdown; anything unreadable is left as is. */
export function readableDescription(md: string): string {
  return md
    .replace(/<linear-image>([\s\S]*?)<\/linear-image>/g, (tag, json: string) => {
      const o = parseObject(json)
      const attrs = o && typeof o.attrs === 'object' && o.attrs ? (o.attrs as Record<string, unknown>) : null
      const src = str(attrs?.src)
      return src ? `![${str(attrs?.title)}](${src})` : tag
    })
    .replace(/<linear-embed node-type="([^"]*)">([\s\S]*?)<\/linear-embed>/g, (tag, type: string, json: string) => {
      const o = parseObject(json)
      const src = str(o?.src)
      if (!src) return tag
      const title = str(o?.title)
      return type === 'video' ? `[vidéo : ${title}](${src})` : `[fichier : ${title}](${src})`
    })
}

/** First message sent to Claude when a Linear issue is launched. */
export function linearLaunchPrompt(i: LinearIssue): string {
  const parts = [`Ticket ${i.id} : ${i.title}\n${i.url}`]
  const desc = readableDescription(i.description).trim()
  if (desc) parts.push(desc)
  parts.push(LINEAR_MCP_NOTE)
  return parts.join('\n\n')
}

/** A ticket that left the list; kept in the state until acknowledged. */
export interface Departure { id: string; title: string; reason: 'reassigned' | 'canceled' | 'missing' }

export interface LinearListState {
  issues: LinearIssue[]
  fetchedAt: string | null
  error: string | null
  expired: boolean
  departures: Departure[]
  /** Listed issues kept whatever their status or assignee (launched, or with an unsent edit): see `listGroup`. */
  kept: string[]
}

export interface LinearConnection {
  /** `offline`: tokens are stored but Linear could not be reached; every refresh tries them again. */
  state: 'disconnected' | 'connected' | 'expired' | 'offline'
  /** Why the connection is `offline`, in French. */
  error?: string
  workspace?: string
  email?: string
  /** Bastien's Linear user id, from `whoami`. */
  userId?: string
  missingTools: string[]
}

/** Bastien's edit of a Linear issue: only the fields he changed. */
export interface LinearChange {
  title?: string
  /** `base`: the description as Linear gave it when Bastien started editing; `text`: his version. */
  description?: { base: string; text: string }
  statusId?: string
  priority?: TicketPriority
  /**
   * `base`: the labels the editor showed when Bastien changed them; `next`: his set. Main applies what he added and
   * removed (`base` -> `next`) to Linear's current set, so a colleague's label added meanwhile stays.
   */
  labels?: { base: string[]; next: string[] }
  /** `null` removes the assignee. */
  assigneeId?: string | null
}

export type LinearField = keyof LinearChange

/**
 * - `sent`: Linear saved every field of this save.
 * - `pending`: some fields are not saved yet (network, expired or missing connection, a field Linear refused); they stay
 *   queued, `reason` in French.
 * - `conflict`: a colleague changed the same passage of the description; the description was not sent and stays queued.
 *
 * `issue` (always on `sent`, on the others when another field of the same save went through) is Linear's answer. A
 * `save_issue` answer has no `parentId`, `cycle` nor `project` (always null there): do not trust those three fields
 * from it, merge them with the cached copy.
 */
export type SaveResult =
  | { kind: 'sent'; issue: LinearIssue }
  | { kind: 'pending'; reason: string; issue?: LinearIssue }
  | { kind: 'conflict'; field: 'description'; remote: string; mine: string; issue?: LinearIssue }

export interface PendingEdit {
  id: string
  /** Every field not saved yet. */
  change: LinearChange
  /** Last failure of the whole send (network, connection); '' when none. */
  error: string
  /** Fields Linear would not take (conflict, refusal), with why. Not resent until changed again or `retryAll`. */
  held: Partial<Record<LinearField, string>>
  /** A description patch may already be applied (the answer was lost): resent only if Linear still has the base. */
  uncertain: boolean
}

/** Linear's own limits (not the local tickets' ones). */
export const LINEAR_MAX_TITLE = 1000
export const LINEAR_MAX_LABELS = 100
export const LINEAR_MAX_LABEL = 200

/** `current` with what Bastien added and removed between `base` and `next`; Linear's order kept, additions last. */
export function applyLabels(current: string[], change: { base: string[]; next: string[] }): string[] {
  const removed = new Set(change.base.filter((l) => !change.next.includes(l)))
  const added = change.next.filter((l) => !change.base.includes(l))
  const kept = current.filter((l) => !removed.has(l))
  return [...kept, ...added.filter((l) => !kept.includes(l))]
}

/** A description resent after a lost answer no longer matches its base: the earlier send may have been applied. */
export const UNCERTAIN_REASON = 'Linear a peut-être déjà reçu cette modification : vérifie les deux versions.'

export interface LinearLaunchRequest { id: string; branch: string; target: LaunchTarget }
