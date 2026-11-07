import { expect, test } from 'vitest'
import { folderNeedsAttention, PrCache, repoNeedsAttention, worktreeStatus, type Activity } from '../../src/main/status'
import type { PrState } from '../../src/main/git/pr'

const activities: Activity[] = ['waiting', 'working', 'idle']
const prs: PrState[] = ['open', 'none', 'unavailable']

test('priority: waiting, working, pr_open, idle, for every combination', () => {
  for (const a of activities) {
    for (const p of prs) {
      const expected = a === 'waiting' ? 'waiting' : a === 'working' ? 'working' : p === 'open' ? 'pr_open' : 'idle'
      expect(worktreeStatus(a, p), `${a} + ${p}`).toBe(expected)
    }
  }
})

test('repoNeedsAttention is true for a repo whose worktree waits, shown or not', async () => {
  const worktrees = async (repo: string): Promise<string[]> => (repo === '/other' ? ['/other', '/elsewhere/other-wt'] : ['/shown'])
  const activity = (cwd: string): Activity => (cwd === '/elsewhere/other-wt' ? 'waiting' : 'working')
  expect(await repoNeedsAttention('/other', { worktrees, activity })).toBe(true)
  expect(await repoNeedsAttention('/shown', { worktrees, activity })).toBe(false)
})

test('repoNeedsAttention is false when worktrees cannot be listed', async () => {
  const worktrees = async (): Promise<string[]> => { throw new Error('gone') }
  expect(await repoNeedsAttention('/x', { worktrees, activity: () => 'waiting' })).toBe(false)
})

test('folderNeedsAttention aggregates the repos of a parent folder', async () => {
  const worktrees = async (repo: string): Promise<string[]> => [repo]
  const repos = async (): Promise<string[]> => ['/ws/a', '/ws/b']
  expect(await folderNeedsAttention('/ws', repos, { worktrees, activity: (cwd) => (cwd === '/ws/b' ? 'waiting' : 'idle') })).toBe(true)
  expect(await folderNeedsAttention('/ws', repos, { worktrees, activity: () => 'idle' })).toBe(false)
})

test('folderNeedsAttention asks about the path itself when nothing is found under it, or the search fails', async () => {
  const worktrees = async (repo: string): Promise<string[]> => [repo]
  const activity = (cwd: string): Activity => (cwd === '/r' ? 'waiting' : 'idle')
  expect(await folderNeedsAttention('/r', async () => [], { worktrees, activity })).toBe(true)
  expect(await folderNeedsAttention('/r', async () => { throw new Error('gone') }, { worktrees, activity })).toBe(true)
})

test('folderNeedsAttention can leave one repo out, also when it is the only one', async () => {
  const worktrees = async (repo: string): Promise<string[]> => [repo]
  const activity = (cwd: string): Activity => (cwd === '/ws/a' ? 'waiting' : 'idle')
  const repos = async (): Promise<string[]> => ['/ws/a', '/ws/b']
  expect(await folderNeedsAttention('/ws', repos, { worktrees, activity }, '/ws/a')).toBe(false)
  expect(await folderNeedsAttention('/ws', repos, { worktrees, activity }, '/ws/b')).toBe(true)
  expect(await folderNeedsAttention('/ws/a', async () => [], { worktrees, activity }, '/ws/a')).toBe(false)
})

test('PrCache polls a worktree at most every 60 s, and shares concurrent reads', async () => {
  let t = 0
  let calls = 0
  const cache = new PrCache(async () => { calls++; return 'open' }, () => t)
  const [a, b] = await Promise.all([cache.get('/wt'), cache.get('/wt')])
  expect([a, b, calls]).toEqual(['open', 'open', 1])
  t = 59_000
  await cache.get('/wt')
  expect(calls).toBe(1)
  t = 61_000
  await cache.get('/wt')
  expect(calls).toBe(2)
})

test('PrCache refreshes on focus, but not twice within seconds, and keeps worktrees apart', async () => {
  let t = 0
  const seen: string[] = []
  const cache = new PrCache(async (cwd) => { seen.push(cwd); return 'none' }, () => t)
  await cache.get('/a')
  await cache.get('/b')
  t = 2_000
  await cache.get('/a', true)
  t = 10_000
  await cache.get('/a', true)
  expect(seen).toEqual(['/a', '/b', '/a'])
})
