import { expect, test } from 'vitest'
import type { Activity, Workspace, Worktree } from '../../src/shared/types'
import { createStatusReads, rowStatuses, statusRows, worktreeStatus, type StatusRow } from '../../src/renderer/shell/statusReads'

const rows: StatusRow[] = [
  { path: '/a', repo: '/a', branch: 'main' },
  { path: '/a/.worktrees/x', repo: '/a', branch: 'feat/x' },
  { path: '/b', repo: '/b', branch: 'main' },
  { path: '/b/.worktrees/y', repo: '/b', branch: null }
]

function setup(openPrs: (repo: string) => Promise<string[] | null> = async () => [], activeRepo = '/a') {
  const prCalls: [string, boolean][] = []
  const activityCalls: string[] = []
  const got: { activity: Record<string, Activity>; prs: Record<string, string[] | null> } = { activity: {}, prs: {} }
  const reads = createStatusReads(rows, {
    activity: async (path) => { activityCalls.push(path); return path === '/a' ? 'waiting' : 'idle' },
    openPrs: (repo, soon) => { prCalls.push([repo, soon]); return openPrs(repo) },
    activeRepo: () => activeRepo,
    onActivity: (path, activity) => { got.activity[path] = activity },
    onPrs: (repo, branches) => { got.prs[repo] = branches }
  })
  return { reads, prCalls, activityCalls, got }
}

test('priority: waiting, working, pr_open, idle, for every combination', () => {
  for (const a of ['waiting', 'working', 'idle'] as const) {
    for (const pr of [true, false]) {
      const expected = a === 'waiting' ? 'waiting' : a === 'working' ? 'working' : pr ? 'pr_open' : 'idle'
      expect(worktreeStatus(a, pr), `${a} + ${pr}`).toBe(expected)
    }
  }
})

test('a poll asks gh once per repo, however many worktrees it has', async () => {
  const { reads, prCalls } = setup()
  await reads.prs(false)
  expect(prCalls).toEqual([['/a', false], ['/b', false]])
})

test('a session changing state reads activities and never asks gh', async () => {
  const { reads, prCalls, activityCalls } = setup()
  await reads.activities()
  expect(activityCalls).toEqual(rows.map((r) => r.path))
  expect(prCalls).toEqual([])
})

test('a focus asks sooner for the active repo alone', async () => {
  const { reads, prCalls } = setup()
  await reads.prs(true)
  expect(prCalls).toEqual([['/a', true], ['/b', false]])
})

test('activity does not wait for gh: "waiting" shows while gh hangs', async () => {
  const { reads, got } = setup(() => new Promise(() => undefined))
  void reads.prs(false)
  await reads.activities()
  expect(rowStatuses(rows, got.activity, got.prs)['/a']).toBe('waiting')
})

test('a failing read keeps what was known', async () => {
  const got: string[] = []
  const reads = createStatusReads(rows, {
    activity: async () => { throw new Error('gone') },
    openPrs: async () => { throw new Error('gone') },
    activeRepo: () => null,
    onActivity: (path) => { got.push(path) },
    onPrs: (repo) => { got.push(repo) }
  })
  await reads.activities()
  await reads.prs(false)
  expect(got).toEqual([])
})

test('rows are matched to the open PRs by branch, within their repo', () => {
  const status = rowStatuses(rows, { '/b': 'idle' }, { '/a': ['feat/x'], '/b': ['feat/x'] })
  expect(status).toEqual({ '/a': 'idle', '/a/.worktrees/x': 'pr_open', '/b': 'idle', '/b/.worktrees/y': 'idle' })
})

test('gh being unavailable leaves rows on their activity', () => {
  expect(rowStatuses(rows, { '/a': 'working' }, { '/a': null })['/a']).toBe('working')
  expect(rowStatuses(rows, {}, { '/a': null })['/a/.worktrees/x']).toBe('idle')
})

test('rows: the live list of the active repo first, for what the last scan does not know yet', () => {
  const entry = (repo: string, path: string, branch: string): Workspace['entries'][number] =>
    ({ repo, repoName: repo, group: 'main', worktree: { path, branch, head: 'h', isMain: true } })
  const workspace: Workspace = { root: '/', truncated: false, failed: [], entries: [entry('/a', '/a', 'old'), entry('/b', '/b', 'main')] }
  const live: Worktree[] = [{ path: '/a', branch: 'renamed', head: 'h', isMain: true }, { path: '/a/new', branch: 'new', head: 'h', isMain: false }]
  expect(statusRows(workspace, live, '/a')).toEqual([
    { path: '/a', repo: '/a', branch: 'renamed' },
    { path: '/a/new', repo: '/a', branch: 'new' },
    { path: '/b', repo: '/b', branch: 'main' }
  ])
})
