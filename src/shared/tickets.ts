export type TicketStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done'

export const STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'À faire',
  in_progress: 'En cours',
  in_review: 'En revue',
  done: 'Terminé',
}

/** Every status, in the order of the file format and of the editor's menu. */
export const STATUSES: TicketStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']

/** List order: what is being worked on first. */
export const STATUS_ORDER: TicketStatus[] = ['in_progress', 'in_review', 'todo', 'backlog', 'done']

export type TicketPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: 'Urgente',
  high: 'Haute',
  medium: 'Moyenne',
  low: 'Basse',
  none: 'Aucune',
}

export const PRIORITIES: TicketPriority[] = ['urgent', 'high', 'medium', 'low', 'none']

/** Limits main enforces on every write; the editor keeps within them so that a save is never refused. */
export const MAX_TITLE = 200
export const MAX_DESCRIPTION = 100_000
export const MAX_SUBTASKS = 200
export const MAX_LABELS = 20
export const MAX_LABEL = 50

export interface Subtask { title: string; done: boolean }

export interface TicketFields {
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  labels: string[]
  subtasks: Subtask[]
  branch?: string
  worktree?: string
  base?: string
}

export interface Ticket extends TicketFields {
  id: string
  created: string
  updated: string
  archived: boolean
}

/** A file that could not be read is listed by name, never overwritten. */
export type TicketListEntry =
  | { kind: 'ticket'; ticket: Ticket }
  | { kind: 'unreadable'; file: string; error: string }

export const BRANCH_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test'] as const

/** Short branch name part: first 5 words of the title, ASCII, dash separated. */
export function branchSlug(title: string): string {
  const words = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
  return words.join('-') || 'ticket'
}

/** A ticket ID: its prefix, a dash, a number. */
export const TICKET_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/

/** A ticket ID prefix: capitals and digits, 10 at most, starting with a letter. Checked in main on every write and by the settings field. */
export const PREFIX_RE = /^[A-Z][A-Z0-9]{0,9}$/

/** First three ASCII letters of the repo folder name, uppercased. */
export function defaultPrefix(repoName: string): string {
  const letters = repoName.replace(/[^A-Za-z]/g, '').slice(0, 3)
  return letters.length === 3 ? letters.toUpperCase() : 'TKT'
}

/** First message sent to Claude when a ticket is launched. */
export function launchPrompt(t: Ticket): string {
  const parts = [`Ticket ${t.id} : ${t.title}`]
  if (t.description.trim()) parts.push(t.description.trim())
  const todo = t.subtasks.filter((s) => !s.done)
  if (todo.length) parts.push(['Sous-tâches restantes :', ...todo.map((s) => `- [ ] ${s.title}`)].join('\n'))
  return parts.join('\n\n')
}

/** Where a launch puts the ticket's branch: a new worktree, or a free existing one. Both start it from `base`. */
export type LaunchTarget = { kind: 'new'; base: string } | { kind: 'existing'; worktree: string; base: string }

export interface LaunchRequest { id: string; branch: string; target: LaunchTarget; setInProgress: boolean }

/**
 * A worktree a launch could use. Not `free`: the main checkout, or a session there is working or waiting.
 * `dirty`: files the launch would set aside. `sessions`: sessions alive there.
 */
export interface LaunchCandidate {
  path: string
  branch: string | null
  free: boolean
  reason?: 'main' | 'working' | 'waiting'
  dirty: number
  sessions: number
}

/** Where a ticket comes from. */
export type TicketSource = 'local' | 'linear'

/** Unique key of a ticket across sources, e.g. `linear:ENG-482`. */
export type TicketKey = `${TicketSource}:${string}`

export function ticketKey(source: TicketSource, id: string): TicketKey {
  return `${source}:${id}`
}

export function parseTicketKey(k: string): { source: TicketSource; id: string } | null {
  const m = /^(local|linear):(.+)$/.exec(k)
  return m ? { source: m[1] as TicketSource, id: m[2] } : null
}
