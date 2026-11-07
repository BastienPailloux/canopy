import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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

  describe('readAtBase', () => {
    it('returns the content at the merge-base', async () => {
      await repo.commit('src/a.txt', 'changed\n')
      expect(await readAtBase(repo.path, 'origin/main', 'src/a.txt')).toBe('one\ntwo\nthree\n')
    })
    it('returns null for a file new on the branch', async () => {
      await repo.commit('fresh.txt', 'x\n')
      expect(await readAtBase(repo.path, 'origin/main', 'fresh.txt')).toBeNull()
    })
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
