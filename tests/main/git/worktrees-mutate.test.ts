import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { createWorktree, listWorktrees, removalRisks, removeWorktree } from '../../../src/main/git/worktrees'

let repo: TestRepo | undefined
afterEach(async () => { await repo?.cleanup(); repo = undefined })

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: ENV })

test('creates a worktree under .worktrees from base, leaving the main repo clean', async () => {
  repo = await createRepo()
  const wt = await createWorktree(repo.path, { name: 'alpha', branch: 'feat/alpha', base: 'main' })
  expect(wt).toMatchObject({ path: join(repo.path, '.worktrees', 'alpha'), branch: 'feat/alpha', isMain: false })
  expect(existsSync(wt.path)).toBe(true)
  expect(g(repo.path, 'rev-parse', 'feat/alpha').trim()).toBe(g(repo.path, 'rev-parse', 'main').trim())
  expect(g(repo.path, 'status', '--porcelain')).toBe('')
  const exclude = await readFile(join(repo.path, '.git', 'info', 'exclude'), 'utf8')
  expect(exclude.split('\n').filter((l) => l === '.worktrees/')).toHaveLength(1)
})

test('does not duplicate the exclude entry and works when called from a linked worktree', async () => {
  repo = await createRepo()
  const a = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  await createWorktree(a.path, { name: 'b', branch: 'feat/b', base: 'main' })
  const exclude = await readFile(join(repo.path, '.git', 'info', 'exclude'), 'utf8')
  expect(exclude.split('\n').filter((l) => l === '.worktrees/')).toHaveLength(1)
})

test('honors parentDir', async () => {
  repo = await createRepo()
  const parent = join(repo.path, '..', 'elsewhere')
  const wt = await createWorktree(repo.path, { name: 'x', branch: 'feat/x', base: 'main', parentDir: parent })
  expect(existsSync(join(parent, 'x'))).toBe(true)
  expect(wt.path).toBe(join(parent, 'x'))
})

test('taken name rejects with a readable error and creates nothing', async () => {
  repo = await createRepo()
  await createWorktree(repo.path, { name: 'alpha', branch: 'feat/alpha', base: 'main' })
  await expect(createWorktree(repo.path, { name: 'alpha', branch: 'feat/other', base: 'main' })).rejects.toThrow(/alpha/)
  expect(g(repo.path, 'branch', '--list', 'feat/other')).toBe('')
  await expect(createWorktree(repo.path, { name: 'beta', branch: 'feat/alpha', base: 'main' })).rejects.toThrow(/feat\/alpha/)
  expect(existsSync(join(repo.path, '.worktrees', 'beta'))).toBe(false)
})

test('removalRisks counts dirty files', async () => {
  repo = await createRepo()
  const wt = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  expect(await removalRisks(wt.path, 'main')).toEqual({ dirty: 0, unpushed: 0 })
  await writeFile(join(wt.path, 'new.txt'), 'x')
  expect(await removalRisks(wt.path, 'main')).toEqual({ dirty: 1, unpushed: 0 })
})

test('removalRisks counts unpushed commits against ref when there is no upstream', async () => {
  repo = await createRepo()
  const wt = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  await writeFile(join(wt.path, 'f.txt'), 'x')
  g(wt.path, 'add', 'f.txt')
  g(wt.path, 'commit', '-m', 'wip')
  expect(await removalRisks(wt.path, 'main')).toEqual({ dirty: 0, unpushed: 1 })
})

test('removalRisks counts unpushed commits against upstream when set', async () => {
  repo = await createRepo({ remote: true })
  const wt = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  g(wt.path, 'push', '-u', 'origin', 'feat/a')
  expect((await removalRisks(wt.path, 'main')).unpushed).toBe(0)
  await writeFile(join(wt.path, 'f.txt'), 'x')
  g(wt.path, 'add', 'f.txt')
  g(wt.path, 'commit', '-m', 'wip')
  expect((await removalRisks(wt.path, 'main')).unpushed).toBe(1)
})

test('removes a clean worktree', async () => {
  repo = await createRepo()
  const wt = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  await removeWorktree(repo.path, wt.path, false)
  expect(existsSync(wt.path)).toBe(false)
  expect(await listWorktrees(repo.path)).toHaveLength(1)
})

test('refuses to remove a dirty worktree without force, removes it with force', async () => {
  repo = await createRepo()
  const wt = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  await writeFile(join(wt.path, 'new.txt'), 'x')
  await expect(removeWorktree(repo.path, wt.path, false)).rejects.toThrow()
  expect(existsSync(wt.path)).toBe(true)
  await removeWorktree(repo.path, wt.path, true)
  expect(existsSync(wt.path)).toBe(false)
})

test('refuses to remove the main worktree', async () => {
  repo = await createRepo()
  await expect(removeWorktree(repo.path, repo.path, true)).rejects.toThrow(/principal|main/i)
  expect(existsSync(repo.path)).toBe(true)
})
