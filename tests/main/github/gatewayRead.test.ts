import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ghGateway, isGhUnavailable } from '../../../src/main/github/gateway'
import { PR_QUERY } from '../../../src/main/github/query'
import type { GhRunner } from '../../../src/main/git/pr'

const FIXTURES = join(__dirname, '../../fixtures/gh')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

type Call = { args: string[]; cwd: string; input?: string }

/** A runner answering by the first matching prefix of the arguments, recording every call. */
function runner(answers: [string[], string | Error][]): { run: GhRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: GhRunner = async (args, cwd, input) => {
    calls.push({ args, cwd, input })
    const hit = answers.find(([prefix]) => prefix.every((a, i) => args[i] === a))
    if (!hit) throw new Error(`unexpected gh ${args.join(' ')}`)
    if (hit[1] instanceof Error) throw hit[1]
    return hit[1]
  }
  return { run, calls }
}

const REPO: [string[], string] = [['repo', 'view'], JSON.stringify({ name: 'canopy', owner: { id: 'U_1', login: 'BastienPailloux' } })]
const ghFailure = (stderr: string) => Object.assign(new Error('Command failed: gh'), { stderr })

test('find returns the latest PR of the branch, any state', async () => {
  const { run, calls } = runner([[['pr', 'list'], fixture('find.json')]])
  const pr = await ghGateway(run).find('/wt', 'feat/linear-tickets')
  expect(pr).toEqual({ number: 9, state: 'merged', title: 'feat(linear): show, edit and launch assigned Linear tickets', url: 'https://github.com/BastienPailloux/canopy/pull/9' })
  expect(calls).toEqual([{ args: ['pr', 'list', '--head', 'feat/linear-tickets', '--state', 'all', '--limit', '1', '--json', 'number,state,title,url,isCrossRepository,isDraft'], cwd: '/wt', input: undefined }])
})

test('find: a draft, no PR, a fork', async () => {
  const one = (o: object) => runner([[['pr', 'list'], JSON.stringify([{ number: 3, state: 'OPEN', title: 't', url: 'u', isCrossRepository: false, isDraft: false, ...o }])]]).run
  expect(await ghGateway(one({ isDraft: true })).find('/wt', 'b')).toMatchObject({ number: 3, state: 'draft' })
  expect(await ghGateway(one({})).find('/wt', 'b')).toMatchObject({ state: 'open' })
  expect(await ghGateway(one({ isCrossRepository: true })).find('/wt', 'b')).toBeNull()
  expect(await ghGateway(runner([[['pr', 'list'], '[]']]).run).find('/wt', 'b')).toBeNull()
})

test('view runs one graphql call with owner, name and number as fields', async () => {
  const { run, calls } = runner([REPO, [['api', 'graphql'], fixture('view-merged.json')]])
  const gateway = ghGateway(run)
  const pr = await gateway.view('/wt', 9)
  expect(pr.number).toBe(9)
  expect(pr.viewerLogin).toBe('BastienPailloux')
  expect(calls.map((c) => c.args)).toEqual([
    ['repo', 'view', '--json', 'owner,name'],
    ['api', 'graphql', '-f', 'owner=BastienPailloux', '-f', 'name=canopy', '-F', 'number=9', '-f', `query=${PR_QUERY}`],
  ])
  // owner and name are read once per worktree
  await gateway.view('/wt', 9)
  expect(calls.filter((c) => c.args[0] === 'repo')).toHaveLength(1)
})

test('rejects with gh\'s stderr', async () => {
  const { run } = runner([REPO, [['api', 'graphql'], ghFailure('HTTP 502: Bad Gateway (https://api.github.com/graphql)\n')]])
  await expect(ghGateway(run).view('/wt', 9)).rejects.toThrow('HTTP 502')
  const find = runner([[['pr', 'list'], ghFailure('gh auth login required')]]).run
  await expect(ghGateway(find).find('/wt', 'b')).rejects.toThrow('gh auth login required')
})

test('gh missing or logged out is unavailable, any other failure is not', async () => {
  const reject = (e: Error) => ghGateway(runner([[['pr', 'list'], e]]).run).find('/wt', 'b').catch((x: unknown) => x)
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
  expect(isGhUnavailable(await reject(missing))).toBe(true)
  for (const stderr of [
    'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
    'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    'none of the git remotes configured for this repository point to a known GitHub host.',
    'no git remotes found'
  ]) expect(isGhUnavailable(await reject(ghFailure(stderr))), stderr).toBe(true)
  for (const stderr of ['HTTP 502: Bad Gateway (https://api.github.com/graphql)', 'error connecting to api.github.com'])
    expect(isGhUnavailable(await reject(ghFailure(stderr))), stderr).toBe(false)
  expect(isGhUnavailable(new Error('GitHub (gh) : hors ligne'))).toBe(false)
})

test('an unreadable answer rejects in French', async () => {
  const { run } = runner([REPO, [['api', 'graphql'], 'not json']])
  await expect(ghGateway(run).view('/wt', 9)).rejects.toThrow('Réponse GitHub illisible')
})

test('options: labels, assignable users and GitHub\'s suggestions', async () => {
  const answer = {
    data: {
      repository: {
        owner: { __typename: 'User', login: 'BastienPailloux' },
        labels: { nodes: [{ name: 'bug' }, { name: 'enhancement' }] },
        assignableUsers: { nodes: [{ login: 'BastienPailloux' }, { login: 'octocat' }] },
        pullRequest: { suggestedReviewers: [{ isAuthor: true, isCommenter: false, reviewer: { login: 'octocat' } }, { isAuthor: false, isCommenter: true, reviewer: { login: 'hubot' } }] },
      },
    },
  }
  const { run, calls } = runner([REPO, [['api', 'graphql'], JSON.stringify(answer)]])
  expect(await ghGateway(run).options('/wt', 9)).toEqual({
    labels: ['bug', 'enhancement'],
    assignable: ['BastienPailloux', 'octocat'],
    suggested: [
      { login: 'octocat', kind: 'user', hint: 'A modifié ces fichiers' },
      { login: 'hubot', kind: 'user', hint: 'A commenté' },
    ],
  })
  // a user's repo has no teams: no second query
  expect(calls.filter((c) => c.args[0] === 'api')).toHaveLength(1)
})

test('options: an organization\'s teams, when they can be read', async () => {
  const answer = (owner: string) => JSON.stringify({ data: { repository: { owner: { __typename: 'Organization', login: owner }, labels: { nodes: [] }, assignableUsers: { nodes: [] }, pullRequest: { suggestedReviewers: [] } } } })
  const teams = JSON.stringify({ data: { organization: { teams: { nodes: [{ slug: 'core' }] } } } })
  // the teams query is the one without a PR number
  const ok: GhRunner = async (args) => (args[0] === 'repo' ? REPO[1] : args.includes('-F') ? answer('acme') : teams)
  expect((await ghGateway(ok).options('/wt', 9)).suggested).toEqual([{ login: 'acme/core', kind: 'team', hint: 'Équipe' }])
  const denied: GhRunner = async (args) => {
    if (args[0] === 'repo') return REPO[1]
    if (args.includes('-F')) return answer('acme')
    throw ghFailure('Your token has not been granted the required scopes: read:org')
  }
  expect((await ghGateway(denied).options('/wt', 9)).suggested).toEqual([])
})

test('failedLog keeps the last 20 non-empty lines of the failed steps', async () => {
  const log = Array.from({ length: 30 }, (_, i) => `e2e\tRun tests\tline ${i + 1}`).join('\n\n') + '\n'
  const { run, calls } = runner([[['run', 'view'], log]])
  const out = await ghGateway(run).failedLog('/wt', 19000000001, 55500000002)
  expect(calls[0].args).toEqual(['run', 'view', '19000000001', '--job', '55500000002', '--log-failed'])
  const lines = out.split('\n')
  expect(lines).toHaveLength(20)
  expect(lines[0]).toBe('e2e\tRun tests\tline 11')
  expect(lines[19]).toBe('e2e\tRun tests\tline 30')
})

test('branchStates reads every PR of the repo', async () => {
  const { run } = runner([[['pr', 'list'], JSON.stringify([{ headRefName: 'feat/a', state: 'MERGED', isCrossRepository: false, updatedAt: '2026-11-08T10:00:00Z' }])]])
  expect(await ghGateway(run).branchStates('/repo')).toEqual(new Map([['feat/a', 'merged']]))
})

test('remoteTip reads the exact ref of the branch on GitHub', async () => {
  const sha = 'c'.repeat(40)
  const { run, calls } = runner([REPO, [['api', 'repos/BastienPailloux/canopy/git/ref/heads/feat%2Fx'], JSON.stringify({ ref: 'refs/heads/feat/x', object: { sha, type: 'commit' } })]])
  expect(await ghGateway(run).remoteTip('/wt', 'feat/x')).toBe(sha)
  expect(calls.at(-1)?.args).toEqual(['api', 'repos/BastienPailloux/canopy/git/ref/heads/feat%2Fx'])
})

test('remoteTip rejects an empty branch or an answer without a sha', async () => {
  await expect(ghGateway(runner([REPO]).run).remoteTip('/wt', '')).rejects.toThrow()
  const { run } = runner([REPO, [['api'], JSON.stringify([{ ref: 'refs/heads/feat/xy' }])]])
  await expect(ghGateway(run).remoteTip('/wt', 'feat/x')).rejects.toThrow()
})
