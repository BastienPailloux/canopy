import { Document, isSeq, parse } from 'yaml'
import { PRIORITIES, STATUSES, type Subtask, type Ticket, type TicketPriority, type TicketStatus } from '../../shared/tickets'

const SUBTASKS_HEADING = '## Sous-tâches'
const KNOWN = ['id', 'title', 'status', 'priority', 'labels', 'created', 'updated', 'archived', 'branch', 'worktree', 'base']

function splitFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!m) throw new Error('Front matter manquant')
  const data = parse(m[1] ?? '') ?? {}
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Front matter invalide')
  return { data: data as Record<string, unknown>, body: m[2] }
}

function str(v: unknown, key: string): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string' || !v) throw new Error(`Champ « ${key} » invalide`)
  return v
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function splitBody(body: string): { description: string; subtasks: Subtask[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const at = lines.map((l) => l.trimEnd()).lastIndexOf(SUBTASKS_HEADING)
  if (at === -1) return { description: body.trim(), subtasks: [] }
  const subtasks: Subtask[] = []
  const rest: string[] = []
  for (const line of lines.slice(at + 1)) {
    const m = /^- \[([ xX])\] (.*)$/.exec(line)
    if (m) subtasks.push({ title: m[2], done: m[1] !== ' ' })
    else if (line.trim()) rest.push(line)
  }
  // No checklist: the heading is plain description text.
  if (!subtasks.length) return { description: body.trim(), subtasks: [] }
  const head = lines.slice(0, at).join('\n').trim()
  return { description: [head, ...rest].filter(Boolean).join('\n\n'), subtasks }
}

/** Throws when the front matter is missing or invalid. */
export function parseTicket(text: string, fileId: string): Ticket {
  const { data, body } = splitFrontMatter(text)
  const status = data.status ?? 'backlog'
  if (!STATUSES.includes(status as TicketStatus)) throw new Error(`Statut inconnu : ${String(status)}`)
  const priority = data.priority ?? 'none'
  if (!PRIORITIES.includes(priority as TicketPriority)) throw new Error(`Priorité inconnue : ${String(priority)}`)
  const labels = data.labels ?? []
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' && typeof l !== 'number')) throw new Error('Champ « labels » invalide')
  const { description, subtasks } = splitBody(body)
  const t: Ticket = {
    id: optStr(data.id) ?? fileId,
    title: str(data.title, 'title'),
    description,
    status: status as TicketStatus,
    priority: priority as TicketPriority,
    labels: labels.map(String),
    subtasks,
    created: str(data.created, 'created'),
    updated: str(data.updated, 'updated'),
    archived: data.archived === true,
  }
  const branch = optStr(data.branch)
  const worktree = optStr(data.worktree)
  const base = optStr(data.base)
  if (branch) t.branch = branch
  if (worktree) t.worktree = worktree
  if (base) t.base = base
  return t
}

/** Front-matter keys Canopy does not know, to write back untouched. Empty when the text is unreadable. */
export function unknownFields(text: string): Record<string, unknown> {
  try {
    const { data } = splitFrontMatter(text)
    return Object.fromEntries(Object.entries(data).filter(([k]) => !KNOWN.includes(k)))
  } catch {
    return {}
  }
}

export function serializeTicket(t: Ticket, extra: Record<string, unknown> = {}): string {
  const front: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    labels: t.labels,
    created: t.created,
    updated: t.updated,
  }
  if (t.archived) front.archived = true
  if (t.branch) front.branch = t.branch
  if (t.worktree) front.worktree = t.worktree
  if (t.base) front.base = t.base
  for (const [k, v] of Object.entries(extra)) if (!KNOWN.includes(k)) front[k] = v
  const doc = new Document(front)
  const labels = doc.get('labels', true)
  if (isSeq(labels)) labels.flow = true
  let out = `---\n${doc.toString({ flowCollectionPadding: false })}---\n${t.description}\n`
  if (t.subtasks.length) {
    out += `\n${SUBTASKS_HEADING}\n${t.subtasks.map((s) => `- [${s.done ? 'x' : ' '}] ${s.title}`).join('\n')}\n`
  }
  return out
}
