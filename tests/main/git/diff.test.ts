import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRepo, type TestRepo } from '../../helpers/repo'
import { changedFiles, readAtBase, worktreeStats } from '../../../src/main/git/diff'

const run = promisify(execFile)
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}
const sh = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', args, { cwd, env: ENV })).stdout.trim()
const write = async (repo: TestRepo, file: string, content: string | Buffer): Promise<void> => {
  const full = join(repo.path, file)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content)
}

describe('diff engine', () => {
  let repo: TestRepo
  beforeEach(async () => {
    repo = await createRepo({ remote: true })
    await repo.commit('src/a.txt', 'one\ntwo\nthree\n', 'add a')
    await sh(repo.path, 'push', 'origin', 'main')
    await sh(repo.path, 'checkout', '-b', 'feat/a')
  })
  afterEach(() => repo.cleanup())

  it('keeps committed changes visible', async () => {
    await repo.commit('src/a.txt', 'one\nTWO\nthree\nfour\n')
    expect(await changedFiles(repo.path, 'origin/main')).toEqual([
      { path: 'src/a.txt', kind: 'M', added: 2, deleted: 1, binary: false }
    ])
  })

  it('includes uncommitted changes', async () => {
    await repo.commit('src/a.txt', 'one\ntwo\nthree\nfour\n') // +1
    await write(repo, 'src/a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n') // +2 more
    const files = await changedFiles(repo.path, 'origin/main')
    expect(files).toEqual([{ path: 'src/a.txt', kind: 'M', added: 3, deleted: 0, binary: false }])
  })

  it('includes untracked files, not ignored ones', async () => {
    await repo.commit('.gitignore', 'ignored.log\n')
    await write(repo, 'new.txt', 'x\ny\nz\n')
    await write(repo, 'ignored.log', 'nope\n')
    const files = await changedFiles(repo.path, 'origin/main')
    expect(files.find((f) => f.path === 'new.txt')).toEqual({
      path: 'new.txt', kind: 'A', added: 3, deleted: 0, binary: false
    })
    expect(files.find((f) => f.path === 'ignored.log')).toBeUndefined()
  })

  it('counts an untracked file without trailing newline', async () => {
    await write(repo, 'nonl.txt', 'a\nb')
    const f = (await changedFiles(repo.path, 'origin/main')).find((x) => x.path === 'nonl.txt')
    expect(f?.added).toBe(2)
  })

  it('flags untracked binary files', async () => {
    await write(repo, 'u.bin', Buffer.from([1, 0, 2, 10, 3]))
    const f = (await changedFiles(repo.path, 'origin/main')).find((x) => x.path === 'u.bin')
    expect(f).toEqual({ path: 'u.bin', kind: 'A', added: 0, deleted: 0, binary: true })
  })

  it('ignores commits landed on base after branching', async () => {
    await sh(repo.path, 'checkout', 'main')
    await repo.commit('landed.txt', 'later\n')
    await sh(repo.path, 'push', 'origin', 'main')
    await sh(repo.path, 'checkout', 'feat/a')
    await repo.commit('mine.txt', 'mine\n')
    const files = await changedFiles(repo.path, 'origin/main')
    expect(files.map((f) => f.path)).toEqual(['mine.txt'])
  })

  it('detects renames', async () => {
    await sh(repo.path, 'mv', 'src/a.txt', 'src/b.txt')
    const files = await changedFiles(repo.path, 'origin/main')
    expect(files).toEqual([
      { path: 'src/b.txt', oldPath: 'src/a.txt', kind: 'R', added: 0, deleted: 0, binary: false }
    ])
  })

  it('reports deletions', async () => {
    await sh(repo.path, 'rm', 'src/a.txt')
    expect(await changedFiles(repo.path, 'origin/main')).toEqual([
      { path: 'src/a.txt', kind: 'D', added: 0, deleted: 3, binary: false }
    ])
  })

  it('flags binary', async () => {
    await write(repo, 'img.bin', Buffer.from([0, 1, 2, 0, 3]))
    await sh(repo.path, 'add', 'img.bin')
    await sh(repo.path, 'commit', '-m', 'bin')
    const f = (await changedFiles(repo.path, 'origin/main')).find((x) => x.path === 'img.bin')
    expect(f).toEqual({ path: 'img.bin', kind: 'A', added: 0, deleted: 0, binary: true })
  })

  it('handles unicode and spaces', async () => {
    await repo.commit('docs/été 1.md', 'a\nb\n')
    await write(repo, 'docs/où ça.md', 'q\n')
    const paths = (await changedFiles(repo.path, 'origin/main')).map((f) => f.path).sort()
    expect(paths).toEqual(['docs/où ça.md', 'docs/été 1.md'])
  })

  it('handles a rename of a unicode path with spaces', async () => {
    await sh(repo.path, 'checkout', 'main')
    await repo.commit('docs/été 1.md', 'a\nb\nc\n')
    await sh(repo.path, 'push', 'origin', 'main')
    await sh(repo.path, 'checkout', 'feat/a')
    await sh(repo.path, 'merge', 'main')
    await sh(repo.path, 'mv', 'docs/été 1.md', 'docs/été 2.md')
    const f = (await changedFiles(repo.path, 'origin/main')).find((x) => x.kind === 'R')
    expect(f?.path).toBe('docs/été 2.md')
    expect(f?.oldPath).toBe('docs/été 1.md')
  })

  it('returns nothing on a clean branch', async () => {
    expect(await changedFiles(repo.path, 'origin/main')).toEqual([])
  })

  it('reports a committed rename with an edit with real counts', async () => {
    await sh(repo.path, 'mv', 'src/a.txt', 'src/c.txt')
    await write(repo, 'src/c.txt', 'one\ntwo\nthree\nfour\n')
    await sh(repo.path, 'add', '-A')
    await sh(repo.path, 'commit', '-m', 'rename+edit')
    expect(await changedFiles(repo.path, 'origin/main')).toEqual([
      { path: 'src/c.txt', oldPath: 'src/a.txt', kind: 'R', added: 1, deleted: 0, binary: false }
    ])
  })

  it('reports a file deleted from the index but recreated on disk as modified', async () => {
    await sh(repo.path, 'rm', '-q', 'src/a.txt')
    await sh(repo.path, 'commit', '-m', 'rm')
    await write(repo, 'src/a.txt', 'n1\nn2\nn3\nn4\n')
    expect(await changedFiles(repo.path, 'origin/main')).toEqual([
      { path: 'src/a.txt', kind: 'M', added: 4, deleted: 3, binary: false }
    ])
  })

  it('reports a file removed with rm --cached but still on disk as modified', async () => {
    await sh(repo.path, 'rm', '-q', '--cached', 'src/a.txt')
    const f = await changedFiles(repo.path, 'origin/main')
    expect(f).toEqual([{ path: 'src/a.txt', kind: 'M', added: 0, deleted: 0, binary: false }])
  })

  it('counts many untracked files exactly', async () => {
    const names = Array.from({ length: 1500 }, (_, i) => `many/f${i}.txt`)
    await Promise.all(names.map((n) => write(repo, n, '1\n2\n3\n')))
    const files = await changedFiles(repo.path, 'origin/main')
    expect(files).toHaveLength(1500)
    expect(files.reduce((n, f) => n + f.added, 0)).toBe(4500)
  })

  it('rejects on an unexpected read error instead of counting zero', async () => {
    await write(repo, 'locked.txt', 'a\n')
    await chmod(join(repo.path, 'locked.txt'), 0o000)
    await expect(changedFiles(repo.path, 'origin/main')).rejects.toThrow()
    await chmod(join(repo.path, 'locked.txt'), 0o644)
  })

  describe('readAtBase', () => {
    it('returns the content at the merge-base', async () => {
      await repo.commit('src/a.txt', 'changed\n')
      expect(await readAtBase(repo.path, 'origin/main', 'src/a.txt')).toBe('one\ntwo\nthree\n')
    })
    it('returns null for a file new on the branch', async () => {
      await repo.commit('fresh.txt', 'x\n')
      expect(await readAtBase(repo.path, 'origin/main', 'fresh.txt')).toBeNull()
    })
    it('does not report a real git failure as a missing file', async () => {
      await expect(readAtBase(repo.path, 'origin/nope', 'src/a.txt')).rejects.toThrow()
    })
    it('reads a file larger than the default buffer', async () => {
      await sh(repo.path, 'checkout', 'main')
      await repo.commit('big.txt', 'x'.repeat(70 * 1024 * 1024))
      await sh(repo.path, 'push', 'origin', 'main')
      await sh(repo.path, 'checkout', 'feat/a')
      await sh(repo.path, 'merge', 'main')
      await repo.commit('big.txt', 'y\n')
      expect((await readAtBase(repo.path, 'origin/main', 'big.txt'))?.length).toBe(70 * 1024 * 1024)
    }, 60000)
    it('handles unicode paths', async () => {
      await sh(repo.path, 'checkout', 'main')
      await repo.commit('été 1.md', 'hello\n')
      await sh(repo.path, 'push', 'origin', 'main')
      await sh(repo.path, 'checkout', 'feat/a')
      await sh(repo.path, 'merge', 'main')
      await repo.commit('été 1.md', 'edited\n')
      expect(await readAtBase(repo.path, 'origin/main', 'été 1.md')).toBe('hello\n')
    })
  })

  describe('worktreeStats', () => {
    it('sums lines and counts commits ahead', async () => {
      await repo.commit('src/a.txt', 'one\nTWO\nthree\nfour\n') // +2 -1
      await repo.commit('b.txt', 'x\ny\n') // +2
      await write(repo, 'u.txt', 'a\nb\nc\n') // +3 untracked
      expect(await worktreeStats(repo.path, 'origin/main')).toEqual({ ahead: 2, added: 7, deleted: 1 })
    })
    it('is zero on a clean branch', async () => {
      expect(await worktreeStats(repo.path, 'origin/main')).toEqual({ ahead: 0, added: 0, deleted: 0 })
    })
  })
})
