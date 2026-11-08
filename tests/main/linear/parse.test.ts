import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ISSUE_FIELDS, LinearError, LinearFormatError, parseChildren, parseComments, parseIssue, parseIssueList,
  parseLabels, parseStatuses, parseUsers, parseWhoami, toolJson, type CallToolResult,
} from '../../../src/main/linear/parse'

const fx = (name: string): CallToolResult => JSON.parse(readFileSync(join(__dirname, '../../fixtures/linear', `${name}.json`), 'utf8'))
const text = (o: unknown, isError?: boolean): CallToolResult => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], ...(isError ? { isError } : {}) })
const json = (name: string, tool = 'x'): unknown => toolJson(tool, fx(name))

const baseIssue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'CAN-9', uuid: 'u9', title: 'T', description: 'D', priority: { value: 2, name: 'High' }, url: 'https://x', updatedAt: '2026-01-01',
  status: 'Todo', statusType: 'unstarted', labels: [], assignee: null, assigneeId: null, parentId: null, team: 'Canopy', teamId: 't1',
  cycleId: null, project: null, ...over,
})

describe('ISSUE_FIELDS', () => {
  it('lists the fields asked from Linear', () => {
    expect(ISSUE_FIELDS).toEqual(['id', 'uuid', 'title', 'description', 'priority', 'url', 'updatedAt', 'status', 'statusType', 'labels', 'assignee', 'assigneeId', 'parentId', 'team', 'teamId', 'cycleId', 'project'])
  })
})

describe('toolJson', () => {
  it('throws LinearError notFound for the unknown issue answer', () => {
    try { toolJson('get_issue', fx('get_issue_unknown')); expect.unreachable() } catch (e) {
      expect(e).toBeInstanceOf(LinearError)
      expect((e as LinearError).notFound).toBe(true)
      expect((e as LinearError).message).toContain('Could not find referenced Issue')
    }
  })
  it('other errors are not notFound', () => {
    try { toolJson('save_issue', text('Error: Patch failed, nothing was saved.', true)); expect.unreachable() } catch (e) {
      expect(e).toBeInstanceOf(LinearError)
      expect((e as LinearError).notFound).toBe(false)
    }
  })
  it('throws LinearFormatError without text block or on invalid JSON', () => {
    expect(() => toolJson('list_issues', { content: [] })).toThrow(LinearFormatError)
    expect(() => toolJson('list_issues', text('not json {'))).toThrow(LinearFormatError)
    expect(() => toolJson('list_issues', text('not json {'))).toThrow(/list_issues/)
  })
})

describe('issues', () => {
  it('parses the list fixture', () => {
    const { issues, cursor } = parseIssueList(json('list_issues_me', 'list_issues'))
    expect(issues).toHaveLength(4)
    expect(cursor).toBeNull()
    for (const i of issues) expect(i.status.type).toBe('unstarted')
    const i = issues.find((x) => x.id === 'CAN-1')!
    expect(i).toMatchObject({ status: { id: null, name: 'Todo', type: 'unstarted' }, priority: 'none', labels: [], assignee: { id: '5d215785-3c9b-44ff-aa4c-f00a2c2229ee', name: 'Bastien' }, team: { name: 'Canopy' }, parentId: null, cycle: null, project: null })
  })
  it('gives the cursor of a page with more results', () => {
    const p1 = parseIssueList(json('list_issues_me_page1', 'list_issues'))
    expect(p1.issues).toHaveLength(2)
    expect(typeof p1.cursor).toBe('string')
    expect(parseIssueList(json('list_issues_me_page2', 'list_issues')).cursor).toBeNull()
  })
  it('parses every get_issue fixture, with and without fields', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(parseIssue(json(`get_issue_CAN-${n}`, 'get_issue')).id).toBe(`CAN-${n}`)
      expect(parseIssue(json(`get_issue_CAN-${n}_default`, 'get_issue')).id).toBe(`CAN-${n}`)
    }
  })
  it('an empty list is not an error', () => {
    expect(parseIssueList({ issues: [], hasNextPage: false })).toEqual({ issues: [], cursor: null })
  })
  it('throws LinearFormatError naming status when it is missing', () => {
    const v = json('list_issues_me', 'list_issues') as { issues: Record<string, unknown>[] }
    delete v.issues[1].status
    expect(() => parseIssueList(v)).toThrow(LinearFormatError)
    expect(() => parseIssueList(v)).toThrow(/status/)
  })
  it('throws on an unknown status type', () => {
    expect(() => parseIssue(baseIssue({ statusType: 'weird' }))).toThrow(/statusType/)
  })
  it('maps priority value', () => {
    expect(parseIssue(baseIssue()).priority).toBe('high')
    expect(() => parseIssue(baseIssue({ priority: 'High' }))).toThrow(/priority/)
  })
  it('non-null cycleId and parentId', () => {
    const i = parseIssue(baseIssue({ cycleId: 'cyc', parentId: 'CAN-1', assignee: 'Bob', assigneeId: 'b1' }))
    expect(i).toMatchObject({ cycle: 'cyc', parentId: 'CAN-1', assignee: { id: 'b1', name: 'Bob' } })
  })
  it('synthetic: labels as strings or {name} objects', () => {
    expect(parseIssue(baseIssue({ labels: ['Bug', { name: 'Feature', id: 'l' }] })).labels).toEqual(['Bug', 'Feature'])
  })
  it('synthetic: unknown label shape throws naming labels', () => {
    expect(() => parseIssue(baseIssue({ labels: [42] }))).toThrow(/labels/)
    expect(() => parseIssue(baseIssue({ labels: [{ title: 'x' }] }))).toThrow(/labels/)
  })
  it('synthetic: project as string or {name}', () => {
    expect(parseIssue(baseIssue({ project: 'Alpha' })).project).toBe('Alpha')
    expect(parseIssue(baseIssue({ project: { name: 'Beta' } })).project).toBe('Beta')
    expect(() => parseIssue(baseIssue({ project: 7 }))).toThrow(/project/)
  })
})

describe('children', () => {
  it('parses the children fixture (empty)', () => {
    expect(parseChildren(json('list_issues_children_CAN-3', 'list_issues'))).toEqual([])
  })
  it('synthetic: keeps id, title and status', () => {
    const v = { issues: [baseIssue({ id: 'CAN-10', title: 'Sub' })], hasNextPage: false }
    expect(parseChildren(v)).toEqual([{ id: 'CAN-10', title: 'Sub', status: { id: null, name: 'Todo', type: 'unstarted' } }])
  })
})

describe('comments', () => {
  it('parses the empty fixtures', () => {
    for (const n of [1, 2, 3, 4]) expect(parseComments(json(`list_comments_CAN-${n}`, 'list_comments'))).toEqual([])
  })
  it('synthetic: author as string, {name}, or under user / createdBy', () => {
    const c = (extra: Record<string, unknown>): unknown => ({ comments: [{ id: 'c', body: 'b', createdAt: 'd', ...extra }], hasNextPage: false })
    expect(parseComments(c({ author: 'A' }))[0]).toEqual({ id: 'c', author: 'A', body: 'b', createdAt: 'd' })
    expect(parseComments(c({ author: { name: 'B' } }))[0].author).toBe('B')
    expect(parseComments(c({ user: { name: 'C' } }))[0].author).toBe('C')
    expect(parseComments(c({ createdBy: 'D' }))[0].author).toBe('D')
    expect(() => parseComments(c({ author: 3 }))).toThrow(/author/)
    expect(() => parseComments(c({}))).toThrow(/author/)
  })
})

describe('statuses, labels, users, whoami', () => {
  it('parses statuses, skipping the duplicate type', () => {
    const s = parseStatuses(json('list_issue_statuses', 'list_issue_statuses'))
    expect(s.map((x) => x.name)).toEqual(['In Review', 'Done', 'Canceled', 'In Progress', 'Todo', 'Backlog'])
    expect(s[0]).toEqual({ id: '5ce0420c-c7ba-4603-a06b-6f8777a4bd4a', name: 'In Review', type: 'started' })
  })
  it('throws on an unknown status type', () => {
    expect(() => parseStatuses([{ id: 'a', name: 'X', type: 'weird' }])).toThrow(LinearFormatError)
  })
  it('parses labels', () => {
    expect(parseLabels(json('list_issue_labels', 'list_issue_labels'))).toEqual(['Improvement', 'Feature', 'Bug'])
  })
  it('parses users', () => {
    const u = parseUsers(json('list_users', 'list_users'))
    expect(u.length).toBeGreaterThan(0)
    expect(u.find((x) => x.name === 'Bastien')).toEqual({ id: '5d215785-3c9b-44ff-aa4c-f00a2c2229ee', name: 'Bastien' })
  })
  it('parses whoami', () => {
    expect(parseWhoami(json('whoami', 'whoami'))).toEqual({ workspace: 'canopy', email: 'bastien.pailloux@hotmail.fr', userId: '5d215785-3c9b-44ff-aa4c-f00a2c2229ee' })
    expect(() => parseWhoami({ user: {} })).toThrow(LinearFormatError)
  })
})
