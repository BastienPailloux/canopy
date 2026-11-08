import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { McpCaller } from './client'
import type { CallToolResult } from './parse'

export interface ReplayOptions {
  /** Directory of the captured answers (`tests/fixtures/linear` layout). Defaults to `tests/fixtures/linear` under the cwd. */
  fixtures?: string
  /** Every call rejects with it while set (read on each call). */
  failWith?: Error
  /** Answers a call instead of the replay when it returns something: a `CallToolResult` as is, anything else as its JSON text. */
  mutate?: (tool: string, args: Record<string, unknown>) => unknown
  /** e2e: while this file exists, every call rejects (checked on each call). */
  failFile?: string
  /** e2e: every call that goes through is appended to this file as one JSON line `{ tool, args }`. */
  logFile?: string
  /** e2e: a colleague's edit. A JSON `{ id, description }` file, applied to the in-memory issue before the next call, then deleted. */
  colleagueFile?: string
  /** Caps `list_issues` pages (Linear's own `limit` still applies). */
  pageSize?: number
}

type Raw = Record<string, unknown>

const answer = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })
const isResult = (v: unknown): v is CallToolResult =>
  typeof v === 'object' && v !== null && Array.isArray((v as CallToolResult).content)
const count = (s: string, sub: string): number => (sub === '' ? 0 : s.split(sub).length - 1)

const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

/** Applies Linear's `save_issue` `patch` ops, atomically; a failure gives Linear's error text. */
function applyPatch(description: string, ops: unknown): { text: string } | { error: string } {
  if (!Array.isArray(ops) || ops.length === 0) return { error: 'Error: patch must be a non-empty array.' }
  let text = description
  for (const [i, raw] of ops.entries()) {
    const op = raw as Raw
    const fail = (field: string, n: number): { error: string } => ({
      error: n === 0
        ? `Error: Patch failed, nothing was saved. Operation ${i + 1} (${op.op}): \`${field}\` not found in the current content. Fetch the latest content and copy the text exactly.`
        : `Error: Patch failed, nothing was saved. Operation ${i + 1} (${op.op}): \`${field}\` matches ${n} locations:\nAdd surrounding text to make it unique, or set replace_all to replace every occurrence.`,
    })
    const once = (field: string): number | { error: string } => {
      const sub = String(op[field] ?? '')
      const n = count(text, sub)
      return n === 1 ? text.indexOf(sub) : fail(field, n)
    }
    switch (op.op) {
      case 'replace': {
        const old = String(op.old_string ?? '')
        const next = String(op.new_string ?? '')
        if (op.replace_all === true) {
          if (count(text, old) === 0) return fail('old_string', 0)
          text = text.split(old).join(next)
        } else {
          const at = once('old_string')
          if (typeof at !== 'number') return at
          text = text.slice(0, at) + next + text.slice(at + old.length)
        }
        break
      }
      case 'insert_before':
      case 'insert_after': {
        const at = once('anchor')
        if (typeof at !== 'number') return at
        const pos = op.op === 'insert_before' ? at : at + String(op.anchor).length
        text = text.slice(0, pos) + String(op.text ?? '') + text.slice(pos)
        break
      }
      case 'prepend': text = String(op.text ?? '') + text; break
      case 'append': text = text + String(op.text ?? ''); break
      case 'replace_range': {
        const from = once('from')
        if (typeof from !== 'number') return from
        const to = once('to')
        if (typeof to !== 'number') return to
        if (to < from) return { error: `Error: Patch failed, nothing was saved. Operation ${i + 1} (replace_range): \`to\` must come after \`from\`.` }
        text = text.slice(0, from) + String(op.new_string ?? '') + text.slice(to)
        break
      }
      default: return { error: `Error: Patch failed, nothing was saved. Operation ${i + 1}: unknown op ${String(op.op)}.` }
    }
  }
  return { text }
}

/**
 * An `McpCaller` replaying the captured Linear answers. Writes (`save_issue`, `save_comment`) change an in-memory copy,
 * so later reads see them. Used by the tests and, behind `CANOPY_FAKE_LINEAR`, by the e2e app.
 */
export function replayLinear(opts: ReplayOptions = {}): McpCaller {
  const dir = opts.fixtures ?? join(process.cwd(), 'tests/fixtures/linear')
  const has = (f: string): boolean => existsSync(join(dir, f))
  const raw = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const payload = (f: string): Raw => {
    const r = raw(f) as CallToolResult
    return JSON.parse(r.content[0]?.text ?? 'null') as Raw
  }

  const tools = raw('tools.json') as { name: string; inputSchema: unknown }[]
  const me = payload('whoami.json')
  const meUser = me.user as Raw
  const statuses = payload('list_issue_statuses.json') as unknown as Raw[]
  const users = (payload('list_users.json').users ?? []) as Raw[]
  const labels = (payload('list_issue_labels.json').labels ?? []) as Raw[]
  const issues: Raw[] = ((payload('list_issues_me.json').issues ?? []) as Raw[]).map((i) => {
    const full = has(`get_issue_${i.id}.json`) ? payload(`get_issue_${i.id}.json`) : {}
    return { parentId: null, cycleId: null, project: null, ...i, ...full }
  })
  const comments = new Map<string, Raw[]>(issues.map((i) => {
    const f = `list_comments_${i.id}.json`
    return [String(i.id), has(f) ? ((payload(f).comments ?? []) as Raw[]) : []]
  }))
  let nextComment = 1

  const find = (id: unknown): Raw | undefined => issues.find((i) => i.id === id || i.uuid === id)
  const unknownIssue = (): CallToolResult => (has('get_issue_unknown.json')
    ? (raw('get_issue_unknown.json') as CallToolResult)
    : failure(JSON.stringify({ error: 'invalid_request', message: 'Could not find referenced Issue.', status: 400 })))
  const user = (ref: unknown): Raw | undefined =>
    ref === 'me' ? meUser : users.find((u) => u.id === ref || u.name === ref || u.email === ref || u.displayName === ref)

  function listIssues(args: Raw): CallToolResult {
    let found = issues
    if (args.assignee === 'me') found = found.filter((i) => i.assigneeId === meUser.id)
    if (args.parentId !== undefined) {
      const parent = find(args.parentId)
      found = found.filter((i) => parent !== undefined && (i.parentId === parent.id || i.parentId === parent.uuid))
    }
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, opts.pageSize ?? Infinity)
    const start = typeof args.cursor === 'string' ? Number(args.cursor.replace(/^replay-/, '')) || 0 : 0
    const fields = Array.isArray(args.fields) && args.fields.length > 0 ? ['id', ...(args.fields as string[])] : null
    const page = found.slice(start, start + limit).map((i) => (fields ? Object.fromEntries(fields.map((f) => [f, i[f] ?? null])) : i))
    const more = start + limit < found.length
    return answer({ issues: page, hasNextPage: more, ...(more ? { cursor: `replay-${start + limit}` } : {}) })
  }

  function getIssue(args: Raw): CallToolResult {
    const issue = find(args.id)
    if (!issue) return unknownIssue()
    if (!Array.isArray(args.fields)) return answer(issue)
    return answer(Object.fromEntries((args.fields as string[]).map((f) => [f, issue[f] ?? null])))
  }

  function saveIssue(args: Raw): CallToolResult {
    if (typeof args.id !== 'string') return failure('Error: replay: save_issue without id (create) is not supported.')
    const issue = find(args.id)
    if (!issue) return unknownIssue()
    const next: Raw = { ...issue }
    if (args.patch !== undefined) {
      if (args.description !== undefined) return failure('Error: pass either description or patch, not both.')
      const r = applyPatch(String(issue.description ?? ''), args.patch)
      if ('error' in r) return failure(r.error)
      next.description = r.text
    }
    if (typeof args.description === 'string') next.description = args.description
    if (typeof args.title === 'string') next.title = args.title
    if (typeof args.priority === 'number') next.priority = { value: args.priority, name: PRIORITY_NAMES[args.priority] ?? 'No priority' }
    if (args.state !== undefined) {
      const s = statuses.find((x) => x.id === args.state || x.name === args.state || x.type === args.state)
      if (!s) return failure(`Error: unknown state ${String(args.state)}`)
      next.status = s.name
      next.statusType = s.type
    }
    if (args.assignee !== undefined) {
      if (args.assignee === null) {
        next.assignee = null
        next.assigneeId = null
      } else {
        const u = user(args.assignee)
        if (!u) return failure(`Error: unknown user ${String(args.assignee)}`)
        next.assignee = u.name
        next.assigneeId = u.id
      }
    }
    if (Array.isArray(args.labels)) {
      const names: string[] = []
      for (const l of args.labels) {
        const found = labels.find((x) => x.id === l || x.name === l)
        if (!found) return failure(`Error: unknown label ${String(l)}`)
        names.push(String(found.name))
      }
      next.labels = names
    }
    if (args.parentId !== undefined) next.parentId = args.parentId
    next.updatedAt = new Date().toISOString()
    Object.assign(issue, next)
    return answer(issue)
  }

  function saveComment(args: Raw): CallToolResult {
    const issue = find(args.issueId)
    if (!issue) return unknownIssue()
    if (typeof args.body !== 'string' || args.body === '') return failure('Error: body is required.')
    const c: Raw = {
      id: `replay-comment-${nextComment++}`,
      body: args.body,
      createdAt: new Date().toISOString(),
      author: { id: meUser.id, name: meUser.name },
    }
    comments.get(String(issue.id))?.push(c)
    return answer(c)
  }

  const down = (): void => {
    if (opts.failWith) throw opts.failWith
    if (opts.failFile && existsSync(opts.failFile)) throw new Error('fetch failed: fake Linear is down')
  }
  const colleague = (): void => {
    if (!opts.colleagueFile || !existsSync(opts.colleagueFile)) return
    const edit = JSON.parse(readFileSync(opts.colleagueFile, 'utf8')) as { id: string; description: string }
    unlinkSync(opts.colleagueFile)
    const issue = find(edit.id)
    if (issue) Object.assign(issue, { description: edit.description, updatedAt: new Date().toISOString() })
  }

  return {
    async listTools() {
      down()
      return structuredClone(tools)
    },
    async callTool(name, args) {
      down()
      colleague()
      if (opts.logFile) appendFileSync(opts.logFile, `${JSON.stringify({ tool: name, args })}\n`)
      const m = opts.mutate?.(name, args)
      if (m !== undefined) return isResult(m) ? m : answer(m)
      switch (name) {
        case 'whoami': return answer(me)
        case 'list_issues': return listIssues(args)
        case 'get_issue': return getIssue(args)
        case 'save_issue': return saveIssue(args)
        case 'list_comments': {
          const issue = find(args.issueId)
          return issue ? answer({ comments: comments.get(String(issue.id)) ?? [], hasNextPage: false }) : unknownIssue()
        }
        case 'save_comment': return saveComment(args)
        case 'list_issue_statuses': return answer(statuses)
        case 'list_issue_labels': return answer({ labels, hasNextPage: false })
        case 'list_users': return answer({ users, hasNextPage: false })
        default: return failure(`Error: replay: no answer for ${name}.`)
      }
    },
    async close() {},
  }
}

/**
 * Test-only, like `CANOPY_FAKE_QUERY`: unpackaged with `CANOPY_FAKE_LINEAR=<fixtures dir>`, every connection replays
 * that directory (one shared replay, so writes survive a reconnect). `CANOPY_FAKE_LINEAR_FAIL`, `_LOG` and `_COLLEAGUE`
 * are file paths for the e2e tests (fail while the file exists, log the calls, apply a colleague's edit), same gate. Never touches the network nor the browser, and
 * `resume()` connects at once.
 */
export function selectLinearOpener(
  real: (interactive: boolean) => Promise<McpCaller>,
  o: { isPackaged: boolean; env: NodeJS.ProcessEnv },
): (interactive: boolean) => Promise<McpCaller> {
  const dir = o.isPackaged ? undefined : o.env.CANOPY_FAKE_LINEAR
  if (!dir) return real
  let caller: McpCaller | null = null
  const e = o.env
  return async () => (caller ??= replayLinear({
    fixtures: resolve(dir), failFile: e.CANOPY_FAKE_LINEAR_FAIL, logFile: e.CANOPY_FAKE_LINEAR_LOG, colleagueFile: e.CANOPY_FAKE_LINEAR_COLLEAGUE,
  }))
}
