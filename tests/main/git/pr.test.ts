import { expect, test } from 'vitest'
import { prState, type GhRunner } from '../../../src/main/git/pr'

const ok = (state: string): GhRunner => async () => JSON.stringify({ state })
const fail = (stderr: string, code?: string): GhRunner => async () => { throw Object.assign(new Error('gh failed'), { stderr, code }) }

test('an open PR', async () => {
  expect(await prState('/wt', ok('OPEN'))).toBe('open')
})

test('a merged or closed PR is not an open one', async () => {
  expect(await prState('/wt', ok('MERGED'))).toBe('none')
  expect(await prState('/wt', ok('CLOSED'))).toBe('none')
})

test('no PR for the branch', async () => {
  expect(await prState('/wt', fail('no pull requests found for branch "feat/x"'))).toBe('none')
})

test('gh missing resolves unavailable without throwing', async () => {
  expect(await prState('/wt', fail('', 'ENOENT'))).toBe('unavailable')
})

test('no remote, no login or unreadable output resolve unavailable', async () => {
  expect(await prState('/wt', fail('none of the git remotes configured for this repository point to a known GitHub host'))).toBe('unavailable')
  expect(await prState('/wt', async () => 'not json')).toBe('unavailable')
  expect(await prState('/wt', async () => '{}')).toBe('unavailable')
})

test('asks gh for the state in the worktree, with an argument array', async () => {
  const calls: [string[], string][] = []
  await prState('/wt', async (args, cwd) => { calls.push([args, cwd]); return '{"state":"OPEN"}' })
  expect(calls).toEqual([[['pr', 'view', '--json', 'state'], '/wt']])
})
