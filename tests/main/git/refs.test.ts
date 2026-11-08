import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createWorktree } from '../../../src/main/git/worktrees'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { aheadCount, listBranches, mergeBase, mostAdvancedBranch, resolveBaseRef, resolveCompareRef } from '../../../src/main/git/refs'

let repo: TestRepo | undefined
afterEach(async () => { await repo?.cleanup(); repo = undefined })

test('uses origin/HEAD when a remote exists', async () => {
  repo = await createRepo({ remote: true })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'main', ref: 'origin/main' })
})

const dropOriginHead = (path: string): void => { execFileSync('git', ['remote', 'set-head', 'origin', '--delete'], { cwd: path }) }

test('with a remote but no origin/HEAD, prefers origin/main over a stale local main', async () => {
  repo = await createRepo({ remote: true })
  dropOriginHead(repo.path)
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'main', ref: 'origin/main' })
})

test('with a remote but no origin/HEAD, finds origin/master before any local branch', async () => {
  repo = await createRepo({ remote: true, branch: 'master' })
  dropOriginHead(repo.path)
  execFileSync('git', ['branch', 'main'], { cwd: repo.path })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'master', ref: 'origin/master' })
})

test('a remote without main or master falls back to the local branch', async () => {
  repo = await createRepo({ remote: true, branch: 'trunk' })
  dropOriginHead(repo.path)
  execFileSync('git', ['branch', 'main'], { cwd: repo.path })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'main', ref: 'main' })
})

test('falls back to master without remote', async () => {
  repo = await createRepo({ branch: 'master' })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'master', ref: 'master' })
})

test('falls back to main without origin/HEAD', async () => {
  repo = await createRepo()
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'main', ref: 'main' })
})

test('throws when no base branch exists', async () => {
  repo = await createRepo({ branch: 'trunk' })
  await expect(resolveBaseRef(repo.path)).rejects.toThrow(/base branch/)
})

test('aheadCount and mergeBase on a feature branch', async () => {
  repo = await createRepo()
  const base = await repo.commit('b.txt', 'b')
  execFileSync('git', ['checkout', '-b', 'feat/x'], { cwd: repo.path, stdio: 'pipe' })
  await repo.commit('c.txt', 'c')
  await repo.commit('d.txt', 'd')
  expect(await aheadCount(repo.path, 'main')).toBe(2)
  expect(await mergeBase(repo.path, 'main')).toBe(base)
})

test('resolveCompareRef defaults to the base branch and accepts a known ref', async () => {
  repo = await createRepo()
  execFileSync('git', ['branch', 'other'], { cwd: repo.path })
  expect(await resolveCompareRef(repo.path)).toEqual({ name: 'main', ref: 'main' })
  expect(await resolveCompareRef(repo.path, 'other')).toEqual({ name: 'other', ref: 'other' })
})

test('resolveCompareRef rejects unknown refs, options and non-strings', async () => {
  repo = await createRepo()
  for (const bad of ['nope', '--output=/tmp/x', '', 42, null]) {
    await expect(resolveCompareRef(repo.path, bad)).rejects.toThrow('Branche de comparaison inconnue')
  }
})

test('listBranches lists local and remote branches, without the origin/HEAD alias', async () => {
  repo = await createRepo({ remote: true })
  execFileSync('git', ['branch', 'feat/x'], { cwd: repo.path })
  expect(await listBranches(repo.path)).toEqual(['feat/x', 'main', 'origin/main'])
})

test('a remote develop is the base when there is no main or master', async () => {
  const repo = await createRepo({ branch: 'develop', remote: true })
  execFileSync('git', ['remote', 'set-head', 'origin', '--delete'], { cwd: repo.path })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'develop', ref: 'origin/develop' })
  await repo.cleanup()
})

test('a local develop is the base with no remote', async () => {
  const repo = await createRepo({ branch: 'develop' })
  await repo.commit('a.txt', 'a\n')
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'develop', ref: 'develop' })
  await repo.cleanup()
})

test('the only remote branch is the base, whatever its name', async () => {
  const repo = await createRepo({ branch: 'release', remote: true })
  execFileSync('git', ['remote', 'set-head', 'origin', '--delete'], { cwd: repo.path })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'release', ref: 'origin/release' })
  await repo.cleanup()
})

const commitAt = (cwd: string, file: string, date: string): void => {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  execFileSync('git', ['commit', '--allow-empty', '-m', file], { cwd, env, stdio: 'pipe' })
}

test('mostAdvancedBranch picks most commits ahead, then most recent', async () => {
  repo = await createRepo()
  const c = await createWorktree(repo.path, { name: 'c', branch: 'feat/c', base: 'main' })
  const b = await createWorktree(repo.path, { name: 'b', branch: 'feat/b', base: 'main' })
  const a = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  for (let i = 0; i < 3; i++) commitAt(c.path, `c${i}`, '2030-01-03T00:00:00Z')
  for (let i = 0; i < 3; i++) commitAt(b.path, `b${i}`, '2030-01-02T00:00:00Z')
  for (let i = 0; i < 2; i++) commitAt(a.path, `a${i}`, '2030-01-04T00:00:00Z')
  expect(await mostAdvancedBranch(repo.path, 'main')).toEqual({ branch: 'feat/c', ahead: 3 })
})

test('mostAdvancedBranch returns null when nothing is ahead', async () => {
  repo = await createRepo()
  await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  expect(await mostAdvancedBranch(repo.path, 'main')).toBeNull()
})
