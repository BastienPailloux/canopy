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

const states = (...list: { number: number; headRefName: string; state: string; isCrossRepository?: boolean }[]): GhRunner => async () => JSON.stringify(list)

test('branchPrStates keeps the latest PR per branch', async () => {
  const got = await branchPrStates('/repo', states(
    { number: 2, headRefName: 'feat/a', state: 'CLOSED' },
    { number: 6, headRefName: 'feat/a', state: 'MERGED' },
    { number: 4, headRefName: 'feat/a', state: 'OPEN' },
    { number: 3, headRefName: 'feat/b', state: 'OPEN' },
    { number: 9, headRefName: 'main', state: 'OPEN', isCrossRepository: true },
  ))
  expect(got).toEqual(new Map([['feat/a', 'merged'], ['feat/b', 'open']]))
})

test('branchPrStates: the latest PR is the newest one, as find sees it, not the last updated', async () => {
  // gh lists the newest first, but an old PR touched last must not win over a newer one either way
  const got = await branchPrStates('/repo', states(
    { number: 5, headRefName: 'feat/a', state: 'MERGED' },
    { number: 7, headRefName: 'feat/a', state: 'OPEN' },
  ))
  expect(got).toEqual(new Map([['feat/a', 'open']]))
})

test('branchPrStates: one call for every state, null on failure', async () => {
  const calls: string[][] = []
  await branchPrStates('/repo', async (args) => { calls.push(args); return '[]' })
  expect(calls).toEqual([['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,headRefName,state,isCrossRepository']])
  expect(await branchPrStates('/repo', fail('', 'ENOENT'))).toBeNull()
  expect(await branchPrStates('/repo', async () => '{}')).toBeNull()
})
