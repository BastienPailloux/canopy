import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listTree } from '../../../src/main/code/files'
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
