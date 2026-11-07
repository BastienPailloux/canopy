import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { aheadCount, mergeBase, resolveBaseRef } from '../../../src/main/git/refs'

let repo: TestRepo | undefined
afterEach(async () => { await repo?.cleanup(); repo = undefined })

test('uses origin/HEAD when a remote exists', async () => {
  repo = await createRepo({ remote: true })
  expect(await resolveBaseRef(repo.path)).toEqual({ name: 'main', ref: 'origin/main' })
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
