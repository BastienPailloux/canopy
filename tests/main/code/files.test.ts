import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXPECT_ABSENT, FILE_CHANGED } from '../../../src/shared/errors'
import { listTree, readFileSafe, watchWorktree, writeFileSafe } from '../../../src/main/code/files'
import { createRepo, type TestRepo } from '../../helpers/repo'

const run = promisify(execFile)

describe('listTree', () => {
  let repo: TestRepo

  beforeEach(async () => { repo = await createRepo() })
  afterEach(async () => { await repo.cleanup() })

  it('lists tracked and untracked files, not ignored ones', async () => {
    await repo.commit('.gitignore', 'ignored.txt\nbuild/\n')
    await repo.commit('src/a.ts', 'a\n')
    await writeFile(join(repo.path, 'untracked.txt'), 'u\n')
    await writeFile(join(repo.path, 'ignored.txt'), 'i\n')
    await mkdir(join(repo.path, 'build'))
    await writeFile(join(repo.path, 'build', 'out.js'), 'o\n')

    expect((await listTree(repo.path)).sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts', 'untracked.txt'])
  })

  it('keeps paths with spaces, accents and newlines intact', async () => {
    await writeFile(join(repo.path, 'été à\nla ligne.txt'), 'x\n')
    expect(await listTree(repo.path)).toContain('été à\nla ligne.txt')
  })

  it('lists each path once during a merge conflict', async () => {
    await repo.commit('c.txt', 'base\n')
    await run('git', ['checkout', '-q', '-b', 'other'], { cwd: repo.path })
    await repo.commit('c.txt', 'other\n')
    await run('git', ['checkout', '-q', 'main'], { cwd: repo.path })
    await repo.commit('c.txt', 'main\n')
    await run('git', ['merge', '-q', 'other'], { cwd: repo.path }).catch(() => undefined)

    expect((await listTree(repo.path)).filter((f) => f === 'c.txt')).toHaveLength(1)
  })

  it('leaves out a nested repository, which git reports as a directory', async () => {
    const nested = join(repo.path, 'nested')
    await mkdir(nested)
    await run('git', ['init', '-q'], { cwd: nested })
    await writeFile(join(nested, 'n.txt'), 'n\n')
    await run('git', ['add', '.'], { cwd: nested })
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'n'], { cwd: nested })

    expect((await listTree(repo.path)).some((f) => f.startsWith('nested'))).toBe(false)
  })
})

describe('readFileSafe', () => {
  let repo: TestRepo

  beforeEach(async () => { repo = await createRepo() })
  afterEach(async () => { await repo.cleanup() })

  it('reads text with a version that follows the content', async () => {
    const a = await readFileSafe(repo.path, 'README.md')
    expect(a).toMatchObject({ kind: 'text', content: '# test\n' })
    await writeFile(join(repo.path, 'README.md'), 'other\n')
    const b = await readFileSafe(repo.path, 'README.md')
    expect(b.kind === 'text' && a.kind === 'text' && b.version !== a.version).toBe(true)
  })

  it('reports binary files', async () => {
    await writeFile(join(repo.path, 'b.bin'), Buffer.from([1, 2, 0, 3]))
    expect(await readFileSafe(repo.path, 'b.bin')).toEqual({ kind: 'binary' })
  })

  it('reports files over 5 MB without reading them', async () => {
    await writeFile(join(repo.path, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97))
    expect(await readFileSafe(repo.path, 'big.txt')).toEqual({ kind: 'tooLarge', size: 5 * 1024 * 1024 + 1 })
  })

  it('rejects paths outside the worktree', async () => {
    await writeFile(join(repo.path, '..', 'secret'), 's')
    await expect(readFileSafe(repo.path, '../secret')).rejects.toThrow()
    await expect(writeFileSafe(repo.path, '../secret', 'x')).rejects.toThrow()
    await expect(readFileSafe(repo.path, join(repo.path, '..', 'secret'))).rejects.toThrow()
    await expect(writeFileSafe(repo.path, 'a/../../secret', 'x')).rejects.toThrow()
    expect(await readFile(join(repo.path, '..', 'secret'), 'utf8')).toBe('s')
  })

  it('refuses a symlink pointing outside, for read and write, and through a linked directory', async () => {
    await writeFile(join(repo.path, '..', 'secret'), 's')
    await symlink(join(repo.path, '..', 'secret'), join(repo.path, 'link'))
    await symlink(join(repo.path, '..'), join(repo.path, 'outdir'))
    await symlink(join(repo.path, '..', 'nowhere'), join(repo.path, 'dangling'))
    await expect(readFileSafe(repo.path, 'link')).rejects.toThrow()
    await expect(writeFileSafe(repo.path, 'link', 'x')).rejects.toThrow()
    await expect(readFileSafe(repo.path, 'outdir/secret')).rejects.toThrow()
    await expect(writeFileSafe(repo.path, 'outdir/new.txt', 'x')).rejects.toThrow()
    await expect(writeFileSafe(repo.path, 'dangling', 'x')).rejects.toThrow()
    expect(await readFile(join(repo.path, '..', 'secret'), 'utf8')).toBe('s')
  })

  it('refuses a symlink that leads into .git, for read and write', async () => {
    await mkdir(join(repo.path, '.git', 'hooks'), { recursive: true })
    await writeFile(join(repo.path, '.git', 'hooks', 'pre-commit'), 'echo hi\n')
    await symlink('.git/hooks/pre-commit', join(repo.path, 'hook'))
    await symlink('.git/hooks', join(repo.path, 'hooks'))
    await expect(readFileSafe(repo.path, 'hook')).rejects.toThrow()
    await expect(writeFileSafe(repo.path, 'hook', '#!/bin/sh\nevil\n')).rejects.toThrow()
    await expect(writeFileSafe(repo.path, 'hooks/post-commit', 'evil')).rejects.toThrow()
    expect(await readFile(join(repo.path, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('echo hi\n')
  })

  it('refuses .git whatever its case, as macOS would open the same folder', async () => {
    await expect(readFileSafe(repo.path, '.GIT/config')).rejects.toThrow('Chemin invalide')
    await expect(writeFileSafe(repo.path, '.Git/hooks/pre-commit', 'x')).rejects.toThrow('Chemin invalide')
    // Not on disk yet, so resolving the path does not bring the real case back.
    await expect(writeFileSafe(repo.path, 'sub/.GIT/config', 'x')).rejects.toThrow('Chemin invalide')
  })

  it('flags text that is not UTF-8, which saving would corrupt', async () => {
    await writeFile(join(repo.path, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    expect(await readFileSafe(repo.path, 'latin.txt')).toMatchObject({ kind: 'text', notUtf8: true })
    await writeFile(join(repo.path, 'utf8.txt'), 'café\n')
    expect(await readFileSafe(repo.path, 'utf8.txt')).not.toHaveProperty('notUtf8')
  })

  it('follows a symlink that stays inside the worktree', async () => {
    await symlink('README.md', join(repo.path, 'inside'))
    expect(await readFileSafe(repo.path, 'inside')).toMatchObject({ kind: 'text', content: '# test\n' })
  })
})

describe('writeFileSafe', () => {
  it('expect-absent writes over a missing file and refuses an existing one', async () => {
    await expect(writeFileSafe(repo.path, 'README.md', 'mine\n', { expectedVersion: EXPECT_ABSENT })).rejects.toThrow(FILE_CHANGED)
    await writeFileSafe(repo.path, 'fresh.txt', 'ok\n', { expectedVersion: EXPECT_ABSENT })
    expect(await readFile(join(repo.path, 'fresh.txt'), 'utf8')).toBe('ok\n')
  })

  let repo: TestRepo

  beforeEach(async () => { repo = await createRepo() })
  afterEach(async () => { await repo.cleanup() })

  it('writes, creating parent folders, and returns the new version', async () => {
    const v = await writeFileSafe(repo.path, 'new/dir/f.txt', 'hello\n')
    expect(await readFile(join(repo.path, 'new/dir/f.txt'), 'utf8')).toBe('hello\n')
    const read = await readFileSafe(repo.path, 'new/dir/f.txt')
    expect(read.kind === 'text' && read.version).toBe(v)
  })

  it('refuses to overwrite a file changed since it was read', async () => {
    const opened = await readFileSafe(repo.path, 'README.md')
    if (opened.kind !== 'text') throw new Error('expected text')
    await writeFile(join(repo.path, 'README.md'), 'claude was here\n')
    await expect(writeFileSafe(repo.path, 'README.md', 'mine\n', { expectedVersion: opened.version })).rejects.toThrow(FILE_CHANGED)
    expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('claude was here\n')
  })

  it('refuses when the file was deleted since it was read, and overwrites when forced', async () => {
    const opened = await readFileSafe(repo.path, 'README.md')
    if (opened.kind !== 'text') throw new Error('expected text')
    await rm(join(repo.path, 'README.md'))
    await expect(writeFileSafe(repo.path, 'README.md', 'mine\n', { expectedVersion: opened.version })).rejects.toThrow(FILE_CHANGED)
    await writeFileSafe(repo.path, 'README.md', 'mine\n')
    expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('mine\n')
  })

  it('refuses to rewrite a file that is not UTF-8, even forced', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    await writeFile(join(repo.path, 'latin.txt'), bytes)
    await expect(writeFileSafe(repo.path, 'latin.txt', 'x')).rejects.toThrow('UTF-8')
    expect(await readFile(join(repo.path, 'latin.txt'))).toEqual(bytes)
  })

  it('refuses a FIFO, for read and write, without blocking on it', async () => {
    await run('mkfifo', [join(repo.path, 'pipe')])
    const notFile = 'Ce chemin n\'est pas un fichier'
    const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('blocked')), 2000))])
    await expect(within(readFileSafe(repo.path, 'pipe'))).rejects.toThrow(notFile)
    await expect(within(writeFileSafe(repo.path, 'pipe', 'x'))).rejects.toThrow(notFile)
  })

  it('refuses to write over a directory, forced or not', async () => {
    await mkdir(join(repo.path, 'dir'))
    await expect(writeFileSafe(repo.path, 'dir', 'x')).rejects.toThrow('Ce chemin n\'est pas un fichier')
    await expect(writeFileSafe(repo.path, 'dir', 'x', { expectedVersion: EXPECT_ABSENT })).rejects.toThrow('Ce chemin n\'est pas un fichier')
  })

  it('creates an absent file only if it is still absent, and leaves nothing behind on a version mismatch', async () => {
    await expect(writeFileSafe(repo.path, 'gone.txt', 'x', { expectedVersion: 'some-old-version' })).rejects.toThrow(FILE_CHANGED)
    await expect(readFile(join(repo.path, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts the write when only the timestamp changed', async () => {
    const opened = await readFileSafe(repo.path, 'README.md')
    if (opened.kind !== 'text') throw new Error('expected text')
    await utimes(join(repo.path, 'README.md'), new Date(0), new Date(0))
    await writeFileSafe(repo.path, 'README.md', 'mine\n', { expectedVersion: opened.version })
    expect(await readFile(join(repo.path, 'README.md'), 'utf8')).toBe('mine\n')
  })
})

describe('watchWorktree', () => {
  let repo: TestRepo
  let stop: (() => void) | undefined

  beforeEach(async () => { repo = await createRepo() })
  afterEach(async () => { stop?.(); await repo.cleanup() })

  const ready = (cwd: string, cb: () => void): Promise<void> =>
    new Promise((resolve) => { stop = watchWorktree(cwd, cb, resolve) })
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('groups a burst of writes into one callback', async () => {
    let calls = 0
    await ready(repo.path, () => { calls++ })
    for (let i = 0; i < 5; i++) await writeFile(join(repo.path, `f${i}.txt`), `${i}\n`)
    await wait(1200)
    expect(calls).toBe(1)
  })

  it('reports a commit but not node_modules or git internals', async () => {
    await mkdir(join(repo.path, 'node_modules'))
    let calls = 0
    await ready(repo.path, () => { calls++ })
    await writeFile(join(repo.path, 'node_modules', 'x.js'), 'x')
    await writeFile(join(repo.path, '.git', 'noise'), 'x')
    await wait(900)
    expect(calls).toBe(0)
    await repo.commit('a.txt', 'a\n')
    await wait(900)
    expect(calls).toBeGreaterThan(0)
  })

  it('ignores the worktrees nested in .worktrees', async () => {
    await mkdir(join(repo.path, '.worktrees', 'feat'), { recursive: true })
    let calls = 0
    await ready(repo.path, () => { calls++ })
    await writeFile(join(repo.path, '.worktrees', 'feat', 'x.ts'), 'x')
    await wait(900)
    expect(calls).toBe(0)
  })

  it('does not even descend into a gitignored folder', async () => {
    await repo.commit('.gitignore', 'dist/\n')
    await mkdir(join(repo.path, 'dist'))
    let calls = 0
    await ready(repo.path, () => { calls++ })
    await writeFile(join(repo.path, 'dist', 'bundle.js'), 'x')
    await wait(900)
    expect(calls).toBe(0)
  })

  it('stays quiet for a gitignored folder created after it started', async () => {
    await repo.commit('.gitignore', 'dist/\n*.log\n')
    let calls = 0
    await ready(repo.path, () => { calls++ })
    await mkdir(join(repo.path, 'dist'))
    await writeFile(join(repo.path, 'dist', 'bundle.js'), 'x')
    await writeFile(join(repo.path, 'debug.log'), 'x')
    await wait(900)
    expect(calls).toBe(0)
    await writeFile(join(repo.path, 'real.ts'), 'x')
    await wait(900)
    expect(calls).toBe(1)
  })

  it('still reports a tracked file under an ignored pattern', async () => {
    await repo.commit('.gitignore', 'dist/\n')
    await mkdir(join(repo.path, 'dist'))
    await writeFile(join(repo.path, 'dist', 'keep.js'), 'x')
    await run('git', ['add', '-f', 'dist/keep.js'], { cwd: repo.path })
    let calls = 0
    await ready(repo.path, () => { calls++ })
    await writeFile(join(repo.path, 'dist', 'keep.js'), 'y')
    await wait(900)
    expect(calls).toBe(1)
  })

  it('reports a worktree added from outside, for a list that polls slowly', async () => {
    // An existing branch: no ref moves, only the list of worktrees.
    await run('git', ['branch', 'feat'], { cwd: repo.path })
    let calls = 0
    await ready(repo.path, () => { calls++ })
    await run('git', ['worktree', 'add', '-q', join(repo.path, '..', 'outside'), 'feat'], { cwd: repo.path })
    await wait(900)
    expect(calls).toBeGreaterThan(0)
  })

  it('reports a commit made in a linked worktree', async () => {
    const linked = join(repo.path, '..', 'linked')
    await run('git', ['worktree', 'add', '-q', '-b', 'feat', linked], { cwd: repo.path })
    let calls = 0
    await ready(linked, () => { calls++ })
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: linked })
    await wait(1200)
    expect(calls).toBeGreaterThan(0)
  })

  it('calls nothing once stopped', async () => {
    let calls = 0
    await ready(repo.path, () => { calls++ })
    stop?.()
    await writeFile(join(repo.path, 'late.txt'), 'x')
    await wait(900)
    expect(calls).toBe(0)
  })
})
