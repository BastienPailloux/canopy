import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { listWorktrees } from '../../../src/main/git/worktrees'

let repo: TestRepo | undefined
afterEach(async () => { await repo?.cleanup(); repo = undefined })

const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

test('lists main and a linked worktree with spaces and accents', async () => {
  repo = await createRepo()
  const wt = join(dirname(repo.path), 'été avec espace')
  g(repo.path, 'worktree', 'add', '-b', 'feat/a', wt)
  const list = await listWorktrees(repo.path)
  expect(list).toHaveLength(2)
  expect(list[0]).toMatchObject({ path: repo.path, branch: 'main', isMain: true })
  expect(list[1]).toMatchObject({ path: wt, branch: 'feat/a', isMain: false })
  expect(list[1].head).toMatch(/^[0-9a-f]{40}$/)
})

test('detached HEAD gives branch null', async () => {
  repo = await createRepo()
  const wt = join(dirname(repo.path), 'detached')
  g(repo.path, 'worktree', 'add', '--detach', wt)
  const list = await listWorktrees(repo.path)
  expect(list[1].branch).toBeNull()
})

test('hides worktrees deleted outside Canopy', async () => {
  repo = await createRepo()
  const wt = join(dirname(repo.path), 'gone')
  g(repo.path, 'worktree', 'add', '-b', 'feat/gone', wt)
  await rm(wt, { recursive: true })
  const list = await listWorktrees(repo.path)
  expect(list.map((w) => w.path)).toEqual([repo.path])
})
