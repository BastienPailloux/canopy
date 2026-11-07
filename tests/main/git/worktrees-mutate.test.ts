import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { createWorktree, listWorktrees, mainWorktreeRoot, removalRisks, removeWorktree } from '../../../src/main/git/worktrees'

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

test('rejects a .worktrees symlink and creates nothing outside the repo', async () => {
  repo = await createRepo()
  const outside = join(repo.path, '..', 'outside')
  await mkdir(outside)
  await symlink(outside, join(repo.path, '.worktrees'))
  await expect(createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })).rejects.toThrow(/\.worktrees/)
  expect(readdirSync(outside)).toEqual([])
  expect(g(repo.path, 'branch', '--list', 'feat/a')).toBe('')
})

test('rejects .worktrees that is a regular file', async () => {
  repo = await createRepo()
  await writeFile(join(repo.path, '.worktrees'), 'x')
  await expect(createWorktree(repo.path, { name: 'a', branch: 'feat/a', base: 'main' })).rejects.toThrow(/\.worktrees/)
})

test.each(['', '.', '..', '../evil', 'a/b', 'a\\b'])('rejects unsafe name %j', async (name) => {
  repo = await createRepo()
  await expect(createWorktree(repo.path, { name, branch: 'feat/z', base: 'main' })).rejects.toThrow(/nom/i)
  expect(g(repo.path, 'branch', '--list', 'feat/z')).toBe('')
})

test('symlinked parentDir works and returns the real path', async () => {
  repo = await createRepo()
  const real = join(repo.path, '..', 'real-parent')
  const link = join(repo.path, '..', 'link-parent')
  await mkdir(real)
  await symlink(real, link)
  const wt = await createWorktree(repo.path, { name: 'x', branch: 'feat/x', base: 'main', parentDir: link })
  expect(wt.path).toBe(join(real, 'x'))
  await removeWorktree(repo.path, join(link, 'x'), false)
  expect(existsSync(join(real, 'x'))).toBe(false)
})

test('main worktree guard compares realpaths', async () => {
  repo = await createRepo()
  const link = join(repo.path, '..', 'main-link')
  await symlink(repo.path, link)
  await expect(removeWorktree(repo.path, link, true)).rejects.toThrow(/principal/)
})

test('mainWorktreeRoot gives the same root from the repo and from a linked worktree', async () => {
  repo = await createRepo()
  const wt = await createWorktree(repo.path, { name: 'alpha', branch: 'feat/alpha', base: 'main' })
  expect(await mainWorktreeRoot(repo.path)).toBe(repo.path)
  expect(await mainWorktreeRoot(wt.path)).toBe(repo.path)
})

test('mainWorktreeRoot rejects outside a git repo', async () => {
  await expect(mainWorktreeRoot(tmpdir())).rejects.toThrow()
})

const config = (cwd: string, key: string): string => {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

test('a new worktree from origin/main does not track it', async () => {
  repo = await createRepo({ remote: true })
  const wt = await createWorktree(repo.path, { name: 'feat-t', branch: 'feat/t', base: 'origin/main' })
  expect(wt.branch).toBe('feat/t')
  expect(config(repo.path, 'branch.feat/t.remote')).toBe('')
})

test('an existing local branch is checked out as it is', async () => {
  repo = await createRepo()
  execFileSync('git', ['branch', 'feat/old'], { cwd: repo.path })
  const wt = await createWorktree(repo.path, { name: 'feat-old', branch: 'feat/old', existing: true })
  expect(wt.branch).toBe('feat/old')
})

test('a teammate\'s remote branch gets a local branch that tracks it', async () => {
  repo = await createRepo({ remote: true })
  execFileSync('git', ['branch', 'pr/x'], { cwd: repo.path })
  execFileSync('git', ['push', '-q', 'origin', 'pr/x'], { cwd: repo.path })
  execFileSync('git', ['branch', '-D', 'pr/x'], { cwd: repo.path })
  const wt = await createWorktree(repo.path, { name: 'pr-x', branch: 'origin/pr/x', existing: true })
  expect(wt.branch).toBe('pr/x')
  expect(config(repo.path, 'branch.pr/x.remote')).toBe('origin')
})

test('a remote branch with a local one of the same name uses the local one', async () => {
  repo = await createRepo({ remote: true })
  execFileSync('git', ['branch', 'pr/y'], { cwd: repo.path })
  execFileSync('git', ['push', '-q', 'origin', 'pr/y'], { cwd: repo.path })
  const wt = await createWorktree(repo.path, { name: 'pr-y', branch: 'origin/pr/y', existing: true })
  expect(wt.branch).toBe('pr/y')
})

test('an existing branch that does not exist is refused', async () => {
  repo = await createRepo()
  await expect(createWorktree(repo.path, { name: 'nope', branch: 'nope', existing: true })).rejects.toThrow(/introuvable/)
})

test('a new worktree still goes through the repo\'s smudge filter: its checkout would be wrong without', async () => {
  repo = await createRepo()
  await repo.commit('.gitattributes', '*.txt filter=upper\n')
  await repo.commit('a.txt', 'a\n')
  execFileSync('git', ['config', 'filter.upper.smudge', 'tr a-z A-Z'], { cwd: repo.path })
  const wt = await createWorktree(repo.path, { name: 'smudged', branch: 'feat/smudged', base: 'main' })
  expect(await readFile(join(wt.path, 'a.txt'), 'utf8')).toBe('A\n')
})
