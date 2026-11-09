import { expect, test } from 'vitest'
import { folderNeedsAttention, PrCache, repoNeedsAttention, type Activity } from '../../src/main/status'

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

test('PrCache reads a repo at most every 60 s, and shares concurrent reads', async () => {
  let t = 0
  let calls = 0
  const cache = new PrCache(async () => { calls++; return ['feat/a'] }, () => t)
  const [a, b] = await Promise.all([cache.get('/repo'), cache.get('/repo')])
  expect([a, b, calls]).toEqual([['feat/a'], ['feat/a'], 1])
  t = 59_000
  await cache.get('/repo')
  expect(calls).toBe(1)
  t = 61_000
  await cache.get('/repo')
  expect(calls).toBe(2)
})

test('PrCache goes below 60 s only when asked to, not twice within seconds, and keeps repos apart', async () => {
  let t = 0
  const seen: string[] = []
  const cache = new PrCache(async (repo) => { seen.push(repo); return [] }, () => t)
  await cache.get('/a')
  await cache.get('/b')
  t = 2_000
  await cache.get('/a', true)
  t = 10_000
  await cache.get('/a', true)
  await cache.get('/b')
  expect(seen).toEqual(['/a', '/b', '/a'])
})

test('PrCache keeps gh being unavailable for as long as an answer: a missing gh is not asked again at each read', async () => {
  let t = 0
  let calls = 0
  const cache = new PrCache(async () => { calls++; throw new Error('no gh') }, () => t)
  expect(await cache.get('/repo')).toBeNull()
  t = 30_000
  expect(await cache.get('/repo')).toBeNull()
  expect(calls).toBe(1)
})

test('PrCache expire makes the next read go to gh whatever its age', async () => {
  let calls = 0
  const cache = new PrCache(async () => { calls++; return [] }, () => 0)
  await cache.get('/a')
  await cache.get('/a', true)
  expect(calls).toBe(1)
  cache.expire()
  await cache.get('/a', true)
  expect(calls).toBe(2)
})
