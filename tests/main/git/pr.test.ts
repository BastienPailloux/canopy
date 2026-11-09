import { expect, test } from 'vitest'
import { branchPrStates, openPrBranches, runWith, type GhRunner } from '../../../src/main/git/pr'

const prs = (...list: { headRefName: string; isCrossRepository?: boolean }[]): GhRunner => async () => JSON.stringify(list)
const fail = (stderr: string, code?: string): GhRunner => async () => { throw Object.assign(new Error('gh failed'), { stderr, code }) }

test('the branches with an open PR', async () => {
  expect(await openPrBranches('/repo', prs({ headRefName: 'feat/a' }, { headRefName: 'feat/b' }))).toEqual(['feat/a', 'feat/b'])
})

test('no open PR is an empty list, not an unknown one', async () => {
  expect(await openPrBranches('/repo', prs())).toEqual([])
})

test('a fork\'s branch is not ours, even under the same name', async () => {
  expect(await openPrBranches('/repo', prs({ headRefName: 'main', isCrossRepository: true }, { headRefName: 'feat/a', isCrossRepository: false }))).toEqual(['feat/a'])
})

test('gh missing resolves null without throwing', async () => {
  expect(await openPrBranches('/repo', fail('', 'ENOENT'))).toBeNull()
})

test('no remote, no login or unreadable output resolve null', async () => {
  expect(await openPrBranches('/repo', fail('none of the git remotes configured for this repository point to a known GitHub host'))).toBeNull()
  expect(await openPrBranches('/repo', async () => 'not json')).toBeNull()
  expect(await openPrBranches('/repo', async () => '{}')).toBeNull()
})

test('one gh call for the repo, with an argument array, past gh\'s default of 30', async () => {
  const calls: [string[], string][] = []
  await openPrBranches('/repo', async (args, cwd) => { calls.push([args, cwd]); return '[]' })
  expect(calls).toEqual([[['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName,isCrossRepository'], '/repo']])
})

test('the runner writes its input to the child\'s stdin', async () => {
  expect(await runWith('cat')([], '/', '-x "q" `b`\nline')).toBe('-x "q" `b`\nline')
})

test('the runner rejects with the child\'s stderr', async () => {
  await expect(runWith('sh')(['-c', 'echo oops >&2; exit 1'], '/')).rejects.toMatchObject({ stderr: 'oops\n' })
})

const states = (...list: { headRefName: string; state: string; isCrossRepository?: boolean; updatedAt: string }[]): GhRunner => async () => JSON.stringify(list)

test('branchPrStates keeps the latest PR per branch', async () => {
  const got = await branchPrStates('/repo', states(
    { headRefName: 'feat/a', state: 'CLOSED', updatedAt: '2026-11-01T10:00:00Z' },
    { headRefName: 'feat/a', state: 'MERGED', updatedAt: '2026-11-05T10:00:00Z' },
    { headRefName: 'feat/a', state: 'OPEN', updatedAt: '2026-11-03T10:00:00Z' },
    { headRefName: 'feat/b', state: 'OPEN', updatedAt: '2026-11-02T10:00:00Z' },
    { headRefName: 'main', state: 'OPEN', isCrossRepository: true, updatedAt: '2026-11-09T10:00:00Z' },
  ))
  expect(got).toEqual(new Map([['feat/a', 'merged'], ['feat/b', 'open']]))
})

test('branchPrStates: one call for every state, null on failure', async () => {
  const calls: string[][] = []
  await branchPrStates('/repo', async (args) => { calls.push(args); return '[]' })
  expect(calls).toEqual([['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'headRefName,state,isCrossRepository,updatedAt']])
  expect(await branchPrStates('/repo', fail('', 'ENOENT'))).toBeNull()
  expect(await branchPrStates('/repo', async () => '{}')).toBeNull()
})
