import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stopAllWatchers, syncWatchers, watchedPaths } from '../../../src/main/code/watchers'
import { createRepo, type TestRepo } from '../../helpers/repo'

const run = promisify(execFile)

describe('syncWatchers', () => {
  let repo: TestRepo

  beforeEach(async () => { repo = await createRepo() })
  afterEach(async () => { stopAllWatchers(); await repo.cleanup() })

  it('watches the listed worktrees and stops the ones no longer listed', async () => {
    const linked = `${repo.path}-linked`
    await run('git', ['worktree', 'add', '-q', '-b', 'feat', linked], { cwd: repo.path })
    await syncWatchers(repo.path, () => undefined, () => undefined)
    expect(watchedPaths().sort()).toEqual([repo.path, linked].sort())

    await run('git', ['worktree', 'remove', '--force', linked], { cwd: repo.path })
    await syncWatchers(repo.path, () => undefined, () => undefined)
    expect(watchedPaths()).toEqual([repo.path])
  })

  it('reports each worktree it stops watching', async () => {
    const linked = `${repo.path}-linked`
    await run('git', ['worktree', 'add', '-q', '-b', 'feat', linked], { cwd: repo.path })
    const stopped: string[] = []
    const sync = (): Promise<void> => syncWatchers(repo.path, () => undefined, () => undefined, (cwd) => stopped.push(cwd))
    await sync()
    expect(stopped).toEqual([])

    await run('git', ['worktree', 'remove', '--force', linked], { cwd: repo.path })
    await sync()
    expect(stopped).toEqual([linked])
  })

  it('drops the watchers of another repo', async () => {
    await syncWatchers(repo.path, () => undefined, () => undefined)
    const other = await createRepo()
    try {
      await syncWatchers(other.path, () => undefined, () => undefined)
      expect(watchedPaths()).toEqual([other.path])
    } finally {
      stopAllWatchers()
      await other.cleanup()
    }
  })
})
