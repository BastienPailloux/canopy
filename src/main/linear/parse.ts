import { priorityFromValue, type LinearComment, type LinearIssue, type LinearStatus, type LinearStatusType, type LinearUser } from '../../shared/linear'

/** Minimal shape of an MCP `CallToolResult` (the SDK is not a dependency yet). */
export interface CallToolResult { content: { type: string; text?: string }[]; isError?: boolean }

/** Linear answered with an error (`isError`). */
export class LinearError extends Error {
  constructor(message: string, readonly notFound: boolean) {
    super(message)
    this.name = 'LinearError'
  }
}

/** The answer does not have the expected shape. */
export class LinearFormatError extends Error {
  constructor(tool: string, field: string) {
    super(`Réponse Linear inattendue (${tool} : ${field})`)
    this.name = 'LinearFormatError'
  }
}

export const ISSUE_FIELDS: string[] = [
  'id', 'uuid', 'title', 'description', 'priority', 'url', 'updatedAt', 'status', 'statusType',
  'labels', 'assignee', 'assigneeId', 'parentId', 'team', 'teamId', 'cycleId', 'project',
]

const STATUS_TYPES: LinearStatusType[] = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'

const NOT_FOUND_RE = /could not find|not found/i

/** Text payload of an answer, parsed; throws on Linear errors and malformed answers. */
export function toolJson(tool: string, r: CallToolResult): unknown {
  const block = Array.isArray(r?.content) ? r.content.find((b) => b?.type === 'text' && typeof b.text === 'string') : undefined
  if (r?.isError) {
    const msg = block?.text ?? 'Erreur Linear'
    let message = msg
    try { const o = JSON.parse(msg); if (isObject(o) && isString(o.message)) message = o.message } catch { /* plain text error */ }
    throw new LinearError(message, NOT_FOUND_RE.test(message))
  }
  if (!block?.text) throw new LinearFormatError(tool, 'content')
  try { return JSON.parse(block.text) } catch { throw new LinearFormatError(tool, 'json') }
}

function str(tool: string, o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (!isString(v)) throw new LinearFormatError(tool, key)
  return v
}

function nullableStr(tool: string, o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  if (v === undefined || v === null) return null
  if (!isString(v)) throw new LinearFormatError(tool, key)
  return v
}

/** A name given as a string or as an object with a `name`. */
function nameOf(v: unknown): string | null {
  if (isString(v)) return v
  if (isObject(v) && isString(v.name)) return v.name
  return null
}

function items(tool: string, v: unknown, key: string): unknown[] {
  if (!isObject(v) || !Array.isArray(v[key])) throw new LinearFormatError(tool, key)
  return v[key] as unknown[]
}

function obj(tool: string, v: unknown, field: string): Record<string, unknown> {
  if (!isObject(v)) throw new LinearFormatError(tool, field)
  return v
}

function statusOf(tool: string, o: Record<string, unknown>): LinearIssue['status'] {
  const type = o.statusType
  if (!STATUS_TYPES.includes(type as LinearStatusType)) throw new LinearFormatError(tool, 'statusType')
  return { id: null, name: str(tool, o, 'status'), type: type as LinearStatusType }
}

function issueOf(tool: string, v: unknown): LinearIssue {
  const o = obj(tool, v, 'issue')
  const priority = o.priority
  if (!isObject(priority) || typeof priority.value !== 'number') throw new LinearFormatError(tool, 'priority')
  if (!Array.isArray(o.labels)) throw new LinearFormatError(tool, 'labels')
  const labels = o.labels.map((l) => {
    const n = nameOf(l)
    if (n === null) throw new LinearFormatError(tool, 'labels')
    return n
  })
  const assigneeName = nullableStr(tool, o, 'assignee')
  const assigneeId = nullableStr(tool, o, 'assigneeId')
  if ((assigneeName === null) !== (assigneeId === null)) throw new LinearFormatError(tool, 'assignee')
  let project: string | null = null
  if (o.project !== undefined && o.project !== null) {
    project = nameOf(o.project)
    if (project === null) throw new LinearFormatError(tool, 'project')
  }
  const description = o.description === undefined || o.description === null ? '' : str(tool, o, 'description')
  return {
    id: str(tool, o, 'id'),
    uuid: str(tool, o, 'uuid'),
    title: str(tool, o, 'title'),
    description,
    url: str(tool, o, 'url'),
    status: statusOf(tool, o),
    priority: priorityFromValue(priority.value),
    labels,
    assignee: assigneeName !== null && assigneeId !== null ? { id: assigneeId, name: assigneeName } : null,
    team: { id: str(tool, o, 'teamId'), name: str(tool, o, 'team') },
    parentId: nullableStr(tool, o, 'parentId'),
    cycle: nullableStr(tool, o, 'cycleId'),
    project,
    updatedAt: str(tool, o, 'updatedAt'),
  }
}

export function parseIssueList(v: unknown): { issues: LinearIssue[]; cursor: string | null } {
  const tool = 'list_issues'
  const issues = items(tool, v, 'issues').map((i) => issueOf(tool, i))
  const o = v as Record<string, unknown>
  const cursor = o.hasNextPage === true && isString(o.cursor) ? o.cursor : null
  if (o.hasNextPage === true && cursor === null) throw new LinearFormatError(tool, 'cursor')
  return { issues, cursor }
}

export function parseIssue(v: unknown): LinearIssue {
  return issueOf('get_issue', v)
}

export function parseChildren(v: unknown): Pick<LinearIssue, 'id' | 'title' | 'status'>[] {
  return parseIssueList(v).issues.map(({ id, title, status }) => ({ id, title, status }))
}

export function parseComments(v: unknown): LinearComment[] {
  const tool = 'list_comments'
  return items(tool, v, 'comments').map((c) => {
    const o = obj(tool, c, 'comment')
    let author: string | null = null
    for (const key of ['author', 'user', 'createdBy']) {
      if (o[key] === undefined || o[key] === null) continue
      author = nameOf(o[key])
      if (author === null) throw new LinearFormatError(tool, 'author')
      break
    }
    if (author === null) throw new LinearFormatError(tool, 'author')
    return { id: str(tool, o, 'id'), author, body: str(tool, o, 'body'), createdAt: str(tool, o, 'createdAt') }
  })
}

export function parseStatuses(v: unknown): LinearStatus[] {
  const tool = 'list_issue_statuses'
  if (!Array.isArray(v)) throw new LinearFormatError(tool, 'statuses')
  const out: LinearStatus[] = []
  for (const s of v) {
    const o = obj(tool, s, 'status')
    if (!STATUS_TYPES.includes(o.type as LinearStatusType)) throw new LinearFormatError(tool, 'type')
    out.push({ id: str(tool, o, 'id'), name: str(tool, o, 'name'), type: o.type as LinearStatusType })
  }
  return out
}

export function parseLabels(v: unknown): string[] {
  const tool = 'list_issue_labels'
  return items(tool, v, 'labels').map((l) => str(tool, obj(tool, l, 'label'), 'name'))
}

export function parseUsers(v: unknown): LinearUser[] {
  const tool = 'list_users'
  return items(tool, v, 'users').map((u) => {
    const o = obj(tool, u, 'user')
    return { id: str(tool, o, 'id'), name: str(tool, o, 'name') }
  })
}

export function parseWhoami(v: unknown): { workspace: string; email: string; userId: string } {
  const tool = 'whoami'
  const o = obj(tool, v, 'whoami')
  const user = obj(tool, o.user, 'user')
  const ws = obj(tool, o.workspace, 'workspace')
  return { workspace: str(tool, ws, 'name'), email: str(tool, user, 'email'), userId: str(tool, user, 'id') }
}
