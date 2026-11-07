import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { createWorktree } from '../../../src/main/git/worktrees'
import { hasSetAsideChanges, switchableBranches, switchBranch } from '../../../src/main/git/switchBranch'

let repo: TestRepo | undefined
afterEach(async () => { await repo?.cleanup(); repo = undefined })

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: ENV }).trim()
const current = (cwd: string): string => g(cwd, 'branch', '--show-current')
const stashes = (cwd: string): string => g(cwd, 'stash', 'list')

test('lists neither the current branch, nor one open elsewhere, nor a remote copy of them', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'free')
  await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  for (const b of ['main', 'feat/a', 'free', 'team']) g(repo.path, 'update-ref', `refs/remotes/origin/${b}`, 'HEAD')
  expect(await switchableBranches(repo.path)).toEqual(['free', 'origin/team'])
})

test('a clean worktree changes branch without setting anything aside', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'other')
  expect(await switchBranch(repo.path, 'other')).toEqual({ conflict: false })
  expect(current(repo.path)).toBe('other')
  expect(stashes(repo.path)).toBe('')
})

test('sets changes aside on leaving a branch and gives them back on return, new files included', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'other')
  await writeFile(join(repo.path, 'README.md'), 'edited\n')
  await writeFile(join(repo.path, 'new.txt'), 'new\n')

  await switchBranch(repo.path, 'other')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('# test\n')
  expect(existsSync(join(repo.path, 'new.txt'))).toBe(false)

  await switchBranch(repo.path, 'main')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('edited\n')
  expect(await readFile(join(repo.path, 'new.txt'), 'utf8')).toBe('new\n')
  expect(stashes(repo.path)).toBe('')
})

test('changes of another branch stay aside', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'one')
  g(repo.path, 'branch', 'two')
  await writeFile(join(repo.path, 'README.md'), 'edited\n')
  await switchBranch(repo.path, 'one')
  await switchBranch(repo.path, 'two')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('# test\n')
  expect(stashes(repo.path)).toContain('canopy:main')
})

test('changes follow their branch into another worktree', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'free')
  const wt = await createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })
  await writeFile(join(wt.path, 'README.md'), 'edited\n')
  await switchBranch(wt.path, 'free')
  await switchBranch(repo.path, 'feat/a')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('edited\n')
})

test('a remote branch becomes a local one tracking it', async () => {
  repo = await createRepo({ remote: true })
  g(repo.path, 'update-ref', 'refs/remotes/origin/feat/team', 'HEAD')
  await switchBranch(repo.path, 'origin/feat/team')
  expect(current(repo.path)).toBe('feat/team')
  expect(g(repo.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feat/team')
})

test('a detached worktree with changes is refused: they would belong to no branch', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'other')
  g(repo.path, 'checkout', '--detach')
  await writeFile(join(repo.path, 'README.md'), 'edited\n')
  await expect(switchBranch(repo.path, 'other')).rejects.toThrow(/détaché/)
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('edited\n')
  expect(stashes(repo.path)).toBe('')
})

test('a clean detached worktree can leave', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'other')
  g(repo.path, 'checkout', '--detach')
  await switchBranch(repo.path, 'other')
  expect(current(repo.path)).toBe('other')
})

test('a refused checkout gives the changes back and stays on the branch', async () => {
  repo = await createRepo()
  await createWorktree(repo.path, { name: 'a', branch: 'held', base: 'main' })
  await writeFile(join(repo.path, 'README.md'), 'edited\n')
  await expect(switchBranch(repo.path, 'held')).rejects.toThrow()
  expect(current(repo.path)).toBe('main')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('edited\n')
  expect(stashes(repo.path)).toBe('')
})

test('an unknown branch is refused before touching the changes', async () => {
  repo = await createRepo()
  await writeFile(join(repo.path, 'README.md'), 'edited\n')
  await expect(switchBranch(repo.path, '--orphan')).rejects.toThrow(/introuvable/)
  expect(stashes(repo.path)).toBe('')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('edited\n')
})

test('a conflict on return says so and keeps what was set aside', async () => {
  repo = await createRepo()
  g(repo.path, 'checkout', '-b', 'work')
  await writeFile(join(repo.path, 'README.md'), 'mine\n')
  await switchBranch(repo.path, 'main')
  // The branch moves while its changes are aside.
  await repo.commit('README.md', 'theirs\n')
  g(repo.path, 'branch', '-f', 'work', 'main')
  g(repo.path, 'checkout', '-b', 'parked')

  expect(await switchBranch(repo.path, 'work')).toEqual({ conflict: true })
  expect(current(repo.path)).toBe('work')
  expect(stashes(repo.path)).toContain('canopy:work')
  expect(await hasSetAsideChanges(repo.path)).toBe(true)
})

test('tells when the current branch has changes waiting, as after coming back from a terminal', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'other')
  await writeFile(join(repo.path, 'README.md'), 'edited\n')
  await switchBranch(repo.path, 'other')
  expect(await hasSetAsideChanges(repo.path)).toBe(false)
  g(repo.path, 'checkout', 'main')
  expect(await hasSetAsideChanges(repo.path)).toBe(true)
})

test('a stash of the user is never touched, even named like a branch', async () => {
  repo = await createRepo()
  g(repo.path, 'branch', 'other')
  await writeFile(join(repo.path, 'README.md'), 'mine\n')
  g(repo.path, 'stash', 'push', '-m', 'main')
  await switchBranch(repo.path, 'other')
  await switchBranch(repo.path, 'main')
  expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('# test\n')
  expect(stashes(repo.path)).toContain('main')
})
