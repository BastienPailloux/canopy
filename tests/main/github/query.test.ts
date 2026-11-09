import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { PR_QUERY, parsePrDetail } from '../../../src/main/github/query'

const FIXTURES = join(__dirname, '../../fixtures/gh')
// A fresh copy each time: tests edit the raw answer.
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const prOf = (raw: any): any => raw.data.repository.pullRequest

test('the query keeps the newest timeline items and threads, and reads checks of the last commit only', () => {
  const q = PR_QUERY.replace(/\s+/g, ' ')
  expect(q).toContain('reviewThreads(last: 100)')
  expect(q).toContain('timelineItems(last: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT])')
  expect(q).toContain('commits(last: 100) { totalCount nodes { commit { oid message committedDate author { name user { login } } statusCheckRollup { state } } } }')
  expect(q).toContain('lastCommit: commits(last: 1)')
  expect(q.match(/contexts\(/g)).toHaveLength(1)
})

test('parses a merged PR', () => {
  const pr = parsePrDetail(fixture('view-merged.json'), 'BastienPailloux')
  expect(pr.number).toBe(9)
  expect(pr.state).toBe('merged')
  expect(pr.title).toBe('feat(linear): show, edit and launch assigned Linear tickets')
  expect(pr.base).toBe('develop')
  expect(pr.head).toBe('feat/linear-tickets')
  expect(pr.author).toEqual({ login: 'BastienPailloux', bot: false })
  expect(pr.viewerIsAuthor).toBe(true)
  expect(pr.repo).toEqual({ owner: 'BastienPailloux', name: 'canopy', methods: ['squash', 'merge', 'rebase'], autoMergeAllowed: false })
  const threads = pr.timeline.flatMap((i) => (i.kind === 'thread' ? [i.thread] : []))
  expect(threads).toHaveLength(2)
  const [first] = threads
  expect(first.path).toBe('src/main/linear/edits.ts')
  expect(first.line).toBe(449)
  expect(first.diffHunk).toMatch(/^@@ /)
  expect(first.resolved).toBe(false)
  expect(first.comments.map((c) => c.author.login)).toEqual(['copilot-pull-request-reviewer', 'BastienPailloux'])
  expect(first.comments[0].author.bot).toBe(true)
  expect(first.comments[0].databaseId).toBe(4507791550)
  expect(pr.files).toHaveLength(100)
  expect(pr.files.every((f) => typeof f.viewed === 'boolean')).toBe(true)
  expect(pr.files[0]).toEqual({ path: 'CLAUDE.md', change: 'M', additions: 3, deletions: 2, viewed: false })
  expect(pr.truncated).toEqual({ timeline: 0, commits: 0, files: 19, checks: 0 })
  expect(pr.reviewers).toEqual([{ login: 'copilot-pull-request-reviewer', kind: 'bot', status: 'commented' }])
  expect(pr.commits).toHaveLength(49)
  expect(pr.checks).toEqual([])
})

test('the timeline is in chronological order', () => {
  const pr = parsePrDetail(fixture('view-merged.json'), 'BastienPailloux')
  const dates = pr.timeline.map((i) => i.at)
  expect(dates).toEqual([...dates].sort())
})

test('pushes collapse consecutive commits by author into one push item', () => {
  const raw = fixture('view-open.json')
  const nodes = prOf(raw).timelineItems.nodes
  const commit = (oid: string, at: string, login: string) => ({ __typename: 'PullRequestCommit', commit: { oid, committedDate: at, author: { name: login, user: { login } } } })
  prOf(raw).timelineItems.nodes = [
    commit('a1', '2026-11-08T10:00:00Z', 'alice'),
    commit('a2', '2026-11-08T10:01:00Z', 'alice'),
    commit('b1', '2026-11-08T10:02:00Z', 'bob'),
    nodes.find((n: any) => n.__typename === 'IssueComment'),
    commit('b2', '2026-11-08T18:00:00Z', 'bob'),
  ]
  const pushes = parsePrDetail(raw, 'x').timeline.filter((i) => i.kind === 'push')
  expect(pushes).toEqual([
    { kind: 'push', at: '2026-11-08T10:01:00Z', author: { login: 'alice', bot: false }, count: 2 },
    { kind: 'push', at: '2026-11-08T10:02:00Z', author: { login: 'bob', bot: false }, count: 1 },
    { kind: 'push', at: '2026-11-08T18:00:00Z', author: { login: 'bob', bot: false }, count: 1 },
  ])
})

test('a review without a body is left to its threads, an approval always shows', () => {
  const raw = fixture('view-open.json')
  const review = (state: string, body: string) => ({ __typename: 'PullRequestReview', state, body, createdAt: '2026-11-08T12:00:00Z', submittedAt: '2026-11-08T12:00:00Z', author: { __typename: 'User', login: 'octocat' } })
  prOf(raw).timelineItems.nodes = [review('COMMENTED', ''), review('APPROVED', ''), review('PENDING', 'draft'), review('CHANGES_REQUESTED', 'Fix it')]
  const reviews = parsePrDetail(raw, 'x').timeline.filter((i) => i.kind === 'review')
  expect(reviews.map((r) => r.kind === 'review' && r.state)).toEqual(['APPROVED', 'CHANGES_REQUESTED'])
})

test('the last commit\'s rollup becomes one ci item', () => {
  const pr = parsePrDetail(fixture('view-open.json'), 'BastienPailloux')
  const ci = pr.timeline.filter((i) => i.kind === 'ci')
  expect(ci).toEqual([{ kind: 'ci', at: '2026-11-08T17:33:14Z', sha: '7f65fa200879ac3689b62436fc8bd7156f3bc198', outcome: 'failure' }])
  expect(pr.commits.map((c) => c.outcome)).toEqual(['success', 'failure'])
})

test('no rollup, no ci item', () => {
  const pr = parsePrDetail(fixture('view-merged.json'), 'BastienPailloux')
  expect(pr.timeline.some((i) => i.kind === 'ci')).toBe(false)
  expect(pr.commits.every((c) => c.outcome === null)).toBe(true)
})

test('checks of another app have run: null', () => {
  const pr = parsePrDetail(fixture('view-open.json'), 'BastienPailloux')
  expect(pr.checks).toEqual([
    { name: 'unit', detail: 'CI', outcome: 'success', durationMs: 90_000, url: 'https://github.com/BastienPailloux/canopy/actions/runs/19000000001/job/55500000001', run: { runId: 19000000001, jobId: 55500000001 } },
    { name: 'e2e', detail: 'CI', outcome: 'failure', durationMs: 222_000, url: 'https://github.com/BastienPailloux/canopy/actions/runs/19000000001/job/55500000002', run: { runId: 19000000001, jobId: 55500000002 } },
    { name: 'Greptile Review', detail: 'Review completed', outcome: 'neutral', durationMs: 160_000, url: 'https://app.greptile.com/review/fake', run: null },
    { name: 'deploy/preview', detail: 'Waiting for build', outcome: 'pending', durationMs: null, url: null, run: null },
  ])
})

test('an open PR: reviewers, labels, assignees, merge state', () => {
  const pr = parsePrDetail(fixture('view-open.json'), 'someone-else')
  expect(pr.state).toBe('open')
  expect(pr.viewerIsAuthor).toBe(false)
  expect(pr.viewerLogin).toBe('someone-else')
  expect(pr.reviewers).toEqual([
    { login: 'octocat', kind: 'user', status: 'pending' },
    { login: 'acme/core', kind: 'team', status: 'pending' },
    { login: 'copilot-pull-request-reviewer', kind: 'bot', status: 'commented' },
  ])
  expect(pr.labels).toEqual(['enhancement'])
  expect(pr.assignees).toEqual(['BastienPailloux'])
  expect(pr.reviewDecision).toBe('REVIEW_REQUIRED')
  expect(pr.mergeStateStatus).toBe('BLOCKED')
  expect(pr.autoMerge).toBe(false)
  expect(pr.repo.methods).toEqual(['squash', 'merge'])
  expect(pr.repo.autoMergeAllowed).toBe(true)
  const comment = pr.timeline.find((i) => i.kind === 'comment')
  expect(comment).toMatchObject({ kind: 'comment', at: '2026-11-08T17:40:00Z', comment: { databaseId: 3500000001, author: { login: 'BastienPailloux', bot: false } } })
})

test('a re-requested reviewer is pending again', () => {
  const raw = fixture('view-open.json')
  prOf(raw).reviewRequests.nodes.push({ requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' } })
  const pr = parsePrDetail(raw, 'x')
  expect(pr.reviewers.filter((r) => r.login === 'copilot-pull-request-reviewer')).toEqual([{ login: 'copilot-pull-request-reviewer', kind: 'bot', status: 'pending' }])
})

test('a draft open PR has state \'draft\'', () => {
  const raw = fixture('view-open.json')
  prOf(raw).isDraft = true
  expect(parsePrDetail(raw, 'x').state).toBe('draft')
})

test('auto-merge on', () => {
  const raw = fixture('view-open.json')
  prOf(raw).autoMergeRequest = { enabledAt: '2026-11-08T18:00:00Z' }
  expect(parsePrDetail(raw, 'x').autoMerge).toBe(true)
})

test('a deleted account shows as ghost', () => {
  const raw = fixture('view-open.json')
  prOf(raw).author = null
  expect(parsePrDetail(raw, 'x').author).toEqual({ login: 'ghost', bot: false })
})

test('marks truncated connections', () => {
  const raw = fixture('view-merged.json')
  prOf(raw).files.totalCount = 150
  prOf(raw).commits.totalCount = 130
  prOf(raw).timelineItems.filteredCount = 120
  expect(parsePrDetail(raw, 'x').truncated).toEqual({ timeline: 70, commits: 81, files: 50, checks: 0 })
})

test('refuses an unknown shape', () => {
  expect(() => parsePrDetail({}, 'x')).toThrow('Réponse GitHub illisible')
  const raw = fixture('view-open.json')
  prOf(raw).number = '8'
  expect(() => parsePrDetail(raw, 'x')).toThrow('Réponse GitHub illisible')
  expect(() => parsePrDetail({ data: { repository: { pullRequest: null } } }, 'x')).toThrow('Réponse GitHub illisible')
})

test('marks truncated checks of the last commit', () => {
  const raw = fixture('view-open.json')
  prOf(raw).lastCommit.nodes[0].commit.statusCheckRollup.contexts.totalCount = 104
  expect(parsePrDetail(raw, 'x').truncated.checks).toBe(100)
})
