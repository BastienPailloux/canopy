import { expect, test } from 'vitest'
import { ghGateway } from '../../../src/main/github/gateway'
import type { PrAction } from '../../../src/shared/pr'
import type { GhRunner } from '../../../src/main/git/pr'

type Call = { args: string[]; cwd: string; input?: string }

/** Answers `repo view` and the PR node id lookup; any other call succeeds with `reply`. Records every call. */
function setup(reply = '', fail?: Error): { run: GhRunner; calls: Call[]; writes: () => Call[] } {
  const calls: Call[] = []
  const run: GhRunner = async (args, cwd, input) => {
    calls.push({ args, cwd, input })
    if (args[0] === 'repo') return JSON.stringify({ name: 'canopy', owner: { login: 'acme' } })
    if (args[0] === 'api' && args.some((a) => a.startsWith('query=query(')) && args.some((a) => a.includes('pullRequest(number: $number) { id }'))) {
      return JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_node1' } } } })
    }
    if (fail) throw fail
    return reply
  }
  // the calls that change something: all but `repo view` and the node id lookup
  const writes = () => calls.filter((c) => c.args[0] !== 'repo' && !c.args.some((a) => a.includes('pullRequest(number: $number) { id }')))
  return { run, calls, writes }
}

async function act(a: PrAction, reply?: string) {
  const s = setup(reply)
  const result = await ghGateway(s.run).act('/wt', 7, a)
  return { result, write: s.writes()[0], all: s.writes(), calls: s.calls }
}

test('comment: pr comment N --body-file - with the body on stdin', async () => {
  const { result, write } = await act({ type: 'comment', body: 'hello' })
  expect(result).toEqual({ ok: true })
  expect(write).toEqual({ args: ['pr', 'comment', '7', '--body-file', '-'], cwd: '/wt', input: 'hello' })
})

test('reply posts to pulls/N/comments/ID/replies with the body from stdin', async () => {
  const { write } = await act({ type: 'reply', commentId: 123, body: 'thx' })
  expect(write.args).toEqual(['api', '-X', 'POST', 'repos/acme/canopy/pulls/7/comments/123/replies', '-F', 'body=@-'])
  expect(write.input).toBe('thx')
})

test('resolve uses resolveReviewThread / unresolveReviewThread', async () => {
  const on = (await act({ type: 'resolve', threadId: 'PRT_1', resolved: true })).write
  const off = (await act({ type: 'resolve', threadId: 'PRT_1', resolved: false })).write
  expect(on.args.slice(0, 3)).toEqual(['api', 'graphql', '-f'])
  expect(on.args.join(' ')).toContain('resolveReviewThread(input: {threadId: $id})')
  expect(on.args).toContain('id=PRT_1')
  expect(off.args.join(' ')).toContain('unresolveReviewThread(input: {threadId: $id})')
})

test('review approve and request-changes', async () => {
  expect((await act({ type: 'review', event: 'APPROVE', body: 'lgtm' })).write).toEqual({ args: ['pr', 'review', '7', '--approve', '--body-file', '-'], cwd: '/wt', input: 'lgtm' })
  expect((await act({ type: 'review', event: 'REQUEST_CHANGES', body: 'no' })).write.args).toEqual(['pr', 'review', '7', '--request-changes', '--body-file', '-'])
})

test('editBody sends the body on stdin', async () => {
  expect((await act({ type: 'editBody', body: 'new' })).write).toEqual({ args: ['pr', 'edit', '7', '--body-file', '-'], cwd: '/wt', input: 'new' })
})

test('draft and ready', async () => {
  expect((await act({ type: 'draft', draft: false })).write.args).toEqual(['pr', 'ready', '7'])
  expect((await act({ type: 'draft', draft: true })).write.args).toEqual(['pr', 'ready', '7', '--undo'])
})

test('close and reopen', async () => {
  expect((await act({ type: 'close' })).write.args).toEqual(['pr', 'close', '7'])
  expect((await act({ type: 'reopen' })).write.args).toEqual(['pr', 'reopen', '7'])
})

test('labels add and remove in one edit', async () => {
  const { write } = await act({ type: 'labels', add: ['bug', '-odd'], remove: ['old'] })
  expect(write.args).toEqual(['pr', 'edit', '7', '--add-label=bug', '--add-label=-odd', '--remove-label=old'])
})

test('assignees add and remove in one edit', async () => {
  const { write } = await act({ type: 'assignees', add: ['alice'], remove: ['bob'] })
  expect(write.args).toEqual(['pr', 'edit', '7', '--add-assignee=alice', '--remove-assignee=bob'])
})

test('reviewers: users and teams through pr edit', async () => {
  const { all } = await act({ type: 'reviewers', add: ['alice', 'acme/core'], remove: ['bob'] })
  expect(all.map((c) => c.args)).toEqual([['pr', 'edit', '7', '--add-reviewer=alice', '--add-reviewer=acme/core', '--remove-reviewer=bob']])
})

test('reviewers: Copilot asked again under its bot login goes through REST too', async () => {
  for (const login of ['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) {
    const { all } = await act({ type: 'reviewers', add: [login], remove: [] })
    expect(all.map((c) => c.args[0]), login).toEqual(['api'])
    expect(JSON.parse(all[0].input!)).toEqual({ reviewers: ['copilot-pull-request-reviewer[bot]'] })
  }
})

test('reviewers: copilot goes through the REST requested_reviewers endpoint', async () => {
  const added = await act({ type: 'reviewers', add: ['copilot', 'alice'], remove: [] })
  expect(added.all.map((c) => c.args)).toEqual([
    ['pr', 'edit', '7', '--add-reviewer=alice'],
    ['api', '-X', 'POST', 'repos/acme/canopy/pulls/7/requested_reviewers', '--input', '-'],
  ])
  expect(JSON.parse(added.all[1].input!)).toEqual({ reviewers: ['copilot-pull-request-reviewer[bot]'] })
  const only = await act({ type: 'reviewers', add: ['copilot'], remove: [] })
  expect(only.all.map((c) => c.args[0])).toEqual(['api'])
  const removed = await act({ type: 'reviewers', add: [], remove: ['copilot'] })
  expect(removed.all[0].args).toEqual(['api', '-X', 'DELETE', 'repos/acme/canopy/pulls/7/requested_reviewers', '--input', '-'])
})

test('an empty edit runs nothing', async () => {
  expect((await act({ type: 'labels', add: [], remove: [] })).all).toEqual([])
})

test('viewed uses markFileAsViewed / unmarkFileAsViewed with the PR node id', async () => {
  const on = (await act({ type: 'viewed', path: 'src/a.ts', viewed: true })).write
  const off = (await act({ type: 'viewed', path: 'src/a.ts', viewed: false })).write
  expect(on.args.join(' ')).toContain('markFileAsViewed(input: {pullRequestId: $id, path: $path})')
  expect(on.args).toContain('id=PR_node1')
  expect(on.args).toContain('path=src/a.ts')
  expect(off.args.join(' ')).toContain('unmarkFileAsViewed(')
})

test('rerun a job and a run\'s failed jobs', async () => {
  expect((await act({ type: 'rerun', runId: 11, jobId: 22 })).write.args).toEqual(['run', 'rerun', '11', '--job', '22'])
  expect((await act({ type: 'rerun', runId: 11, jobId: null })).write.args).toEqual(['run', 'rerun', '11', '--failed'])
})

test('updateBranch', async () => {
  expect((await act({ type: 'updateBranch' })).write.args).toEqual(['pr', 'update-branch', '7'])
})

const HEAD = 'c'.repeat(40)

test('merge squash with subject and body, only at the head shown', async () => {
  const { write } = await act({ type: 'merge', method: 'squash', subject: '-feat: x', body: 'body "q"', headOid: HEAD })
  expect(write).toEqual({ args: ['pr', 'merge', '7', '--squash', `--match-head-commit=${HEAD}`, '--subject=-feat: x', '--body-file', '-'], cwd: '/wt', input: 'body "q"' })
  expect((await act({ type: 'merge', method: 'merge', subject: 's', body: 'b', headOid: HEAD })).write.args).toContain('--merge')
})

test('a rebase takes no subject nor body', async () => {
  const { write } = await act({ type: 'merge', method: 'rebase', subject: 's', body: 'b', headOid: HEAD })
  expect(write.args).toEqual(['pr', 'merge', '7', '--rebase', `--match-head-commit=${HEAD}`])
  expect(write.input).toBeUndefined()
  const auto = await act({ type: 'autoMerge', enable: true, method: 'rebase', subject: '', body: '', headOid: HEAD })
  expect(auto.write.args).toEqual(['pr', 'merge', '7', '--auto', '--rebase', `--match-head-commit=${HEAD}`])
})

test('merge never passes --delete-branch', async () => {
  for (const a of [
    { type: 'merge', method: 'squash', subject: 's', body: 'b', headOid: HEAD },
    { type: 'autoMerge', enable: true, method: 'squash', subject: 's', body: 'b', headOid: HEAD },
  ] as PrAction[]) {
    const { write } = await act(a)
    expect(write.args).not.toContain('--delete-branch')
    expect(write.args).not.toContain('-d')
  }
})

test('auto-merge on and off', async () => {
  expect((await act({ type: 'autoMerge', enable: true, method: 'squash', subject: 's', body: 'b', headOid: HEAD })).write).toEqual({
    args: ['pr', 'merge', '7', '--auto', '--squash', `--match-head-commit=${HEAD}`, '--subject=s', '--body-file', '-'], cwd: '/wt', input: 'b',
  })
  expect((await act({ type: 'autoMerge', enable: false, method: 'squash', subject: 's', body: 'b', headOid: HEAD })).write.args).toEqual(['pr', 'merge', '7', '--disable-auto'])
})

test('revert returns the new PR url', async () => {
  const reply = JSON.stringify({ data: { revertPullRequest: { revertPullRequest: { url: 'https://github.com/acme/canopy/pull/8' } } } })
  const { result, write } = await act({ type: 'revert' }, reply)
  expect(write.args.join(' ')).toContain('revertPullRequest(input: {pullRequestId: $id})')
  expect(write.args).toContain('id=PR_node1')
  expect(result).toEqual({ ok: true, url: 'https://github.com/acme/canopy/pull/8' })
})

test('revert with an unreadable answer fails', async () => {
  await expect(act({ type: 'revert' }, '{}')).rejects.toThrow('illisible')
})

test('deleteRemoteBranch encodes the ref', async () => {
  expect((await act({ type: 'deleteRemoteBranch', branch: 'feat/x' })).write.args).toEqual(['api', '-X', 'DELETE', 'repos/acme/canopy/git/refs/heads/feat%2Fx'])
  await expect(act({ type: 'deleteRemoteBranch', branch: '' })).rejects.toThrow()
})

test('sends bodies through stdin, never in the arguments', async () => {
  const body = '-x "q" `b`\nline'
  for (const a of [
    { type: 'comment', body }, { type: 'reply', commentId: 1, body }, { type: 'review', event: 'APPROVE', body },
    { type: 'editBody', body }, { type: 'merge', method: 'squash', subject: 's', body, headOid: HEAD },
  ] as PrAction[]) {
    const { all } = await act(a)
    expect(all[0].input).toBe(body)
    expect(all.flatMap((c) => c.args).some((x) => x.includes('line'))).toBe(false)
  }
})

test('rejects with gh\'s stderr', async () => {
  const s = setup('', Object.assign(new Error('Command failed'), { stderr: 'GraphQL: nope\n' }))
  await expect(ghGateway(s.run).act('/wt', 7, { type: 'close' })).rejects.toThrow('GitHub (gh) : GraphQL: nope')
})
