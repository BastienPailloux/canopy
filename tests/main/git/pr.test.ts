import { expect, test } from 'vitest'
import { openPrBranches, type GhRunner } from '../../../src/main/git/pr'

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
