import { branchSlug, type TicketPriority, type TicketStatus } from './tickets'

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
}
