import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { createRepo, type TestRepo } from '../../helpers/repo'

// Records each spawned process, to check that a cancelled search kills its own.
const spawned: ChildProcess[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args)
      spawned.push(child)
      return child
    }) as typeof actual.spawn
  }
})

const { searchText } = await import('../../../src/main/code/search')

let repo: TestRepo
beforeEach(async () => { spawned.length = 0; repo = await createRepo() })
afterEach(async () => { await repo.cleanup() })

describe('searchText', () => {
  it('finds the exact line and column', async () => {
    await repo.commit('src/a.ts', 'const x = 1\n  return total(a, b)\n')
    const hits = await searchText(repo.path, 'total', {})
    expect(hits).toEqual([{ path: 'src/a.ts', line: 2, column: 10, text: '  return total(a, b)' }])
  })

  it('counts the column in characters, not bytes', async () => {
    await repo.commit('a.txt', 'éé😀 needle\n')
    const [hit] = await searchText(repo.path, 'needle', {})
    // é é 😀 (2 UTF-16 units) and a space precede it.
    expect(hit.column).toBe(6)
  })

  it('returns every match of a line', async () => {
    await repo.commit('a.txt', 'ab ab\n')
    const hits = await searchText(repo.path, 'ab', {})
    expect(hits.map((h) => h.column)).toEqual([1, 4])
  })

  it('respects .gitignore and skips .git', async () => {
    await repo.commit('.gitignore', 'build/\n')
    await repo.commit('src/a.ts', 'needle\n')
    await mkdir(join(repo.path, 'build'))
    await writeFile(join(repo.path, 'build', 'out.js'), 'needle\n')
    expect((await searchText(repo.path, 'needle', {})).map((h) => h.path)).toEqual(['src/a.ts'])
    expect(await searchText(repo.path, 'refs/heads', {})).toEqual([])
  })

  it('treats a query starting with a dash as a pattern', async () => {
    await repo.commit('a.txt', 'run --verbose now\n')
    const hits = await searchText(repo.path, '--verbose', {})
    expect(hits).toHaveLength(1)
    expect(hits[0].column).toBe(5)
  })

  it('matches literally unless regex is set', async () => {
    await repo.commit('a.txt', 'f(a)\nfaa\n')
    expect(await searchText(repo.path, 'f(a)', {})).toHaveLength(1)
    expect((await searchText(repo.path, 'f(a)', { regex: true })).map((h) => h.line)).toEqual([2])
  })

  it('ignores case unless caseSensitive is set', async () => {
    await repo.commit('a.txt', 'Needle\n')
    expect(await searchText(repo.path, 'needle', {})).toHaveLength(1)
    expect(await searchText(repo.path, 'needle', { caseSensitive: true })).toEqual([])
  })

  it('rejects an invalid regex with a readable message', async () => {
    await repo.commit('a.txt', 'x\n')
    await expect(searchText(repo.path, '(', { regex: true })).rejects.toThrow(/Expression régulière invalide.*unclosed group/)
  })

  it('stops at the limit', async () => {
    await repo.commit('a.txt', 'hit\n'.repeat(50))
    expect(await searchText(repo.path, 'hit', { limit: 10 })).toHaveLength(10)
    expect(await searchText(repo.path, 'hit', {})).toHaveLength(50)
  })

  it('returns an empty list when nothing matches, or the query is empty', async () => {
    await repo.commit('a.txt', 'x\n')
    expect(await searchText(repo.path, 'nothing-here', {})).toEqual([])
    expect(await searchText(repo.path, '', {})).toEqual([])
    expect(spawned).toHaveLength(1)
  })

  it('does not follow symlinks out of the worktree', async () => {
    const outside = await createRepo()
    try {
      await outside.commit('secret.txt', 'needle\n')
      await symlink(outside.path, join(repo.path, 'link'))
      await symlink(join(outside.path, 'secret.txt'), join(repo.path, 'file-link'))
      expect(await searchText(repo.path, 'needle', {})).toEqual([])
    } finally {
      await outside.cleanup()
    }
  })

  it('kills the process when the signal aborts', async () => {
    await repo.commit('a.txt', 'hit\n'.repeat(50))
    const ctl = new AbortController()
    const search = searchText(repo.path, 'hit', { signal: ctl.signal })
    ctl.abort()
    await expect(search).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned[0].killed).toBe(true)
  })

  it('does not start when the signal is already aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(searchText(repo.path, 'x', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned).toHaveLength(0)
  })

  it('still answers when some file cannot be read', async () => {
    await repo.commit('ok.txt', 'needle\n')
    await writeFile(join(repo.path, 'locked.txt'), 'needle\n')
    await chmod(join(repo.path, 'locked.txt'), 0o000)
    expect((await searchText(repo.path, 'needle', {})).map((h) => h.path)).toEqual(['ok.txt'])
    expect(await searchText(repo.path, 'needle', { caseSensitive: true, regex: true })).toHaveLength(1)
    await rm(join(repo.path, 'ok.txt'))
    await repo.commit('other.txt', 'x\n')
    await expect(searchText(repo.path, 'needle', {})).resolves.toEqual([])
  })

  it('rejects when something else kills the process', async () => {
    await repo.commit('a.txt', 'hit\n'.repeat(50))
    const search = searchText(repo.path, 'hit', {})
    spawned[0].kill('SIGKILL')
    await expect(search).rejects.toThrow(/Recherche interrompue/)
  })

  it('cuts very long lines', async () => {
    await repo.commit('min.js', `${'x'.repeat(3000)}needle${'y'.repeat(3000)}\n`)
    const [hit] = await searchText(repo.path, 'needle', {})
    expect(hit.text).toHaveLength(500)
    expect(hit.column).toBe(3001)
  })

  it('bounds the work on a huge line with many matches', async () => {
    await repo.commit('huge.txt', `${'a é '.repeat(20_000)}\n`)
    const started = Date.now()
    const hits = await searchText(repo.path, 'a', { limit: 100 })
    expect(hits).toHaveLength(100)
    expect(hits[99].column).toBe(1 + 99 * 4)
    expect(hits[0].text.length).toBeLessThanOrEqual(500)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('drops a line past the output cap without failing the search', async () => {
    await repo.commit('ok.txt', 'needle\n')
    await repo.commit('wide.txt', `needle${'z'.repeat(9 * 1024 * 1024)}\n`)
    expect((await searchText(repo.path, 'needle', {})).map((h) => h.path)).toEqual(['ok.txt'])
  })
})
