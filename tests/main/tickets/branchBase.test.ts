import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { branchBaseAt } from '../../../src/main/tickets/branchBase'
import { createRepo, type TestRepo } from '../../helpers/repo'

const env = {
  ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString()

let repo: TestRepo
let store: AppStore
beforeEach(async () => {
  repo = await createRepo({ remote: true })
  store = new AppStore(join(await mkdtemp(join(tmpdir(), 'canopy-bb-')), 'state.json'))
  git(repo.path, 'switch', '-c', 'feat/child')
})
afterEach(() => repo.cleanup())

describe('branchBaseAt', () => {
  it('answers null without a remembered base', async () => {
    expect(await branchBaseAt(store, repo.path)).toBeNull()
  })

  it('finds a local base', async () => {
    git(repo.path, 'branch', 'feat/base', 'main')
    store.setBranchBase(repo.path, 'feat/child', 'feat/base')
    expect(await branchBaseAt(store, repo.path)).toEqual({ base: 'feat/base' })
  })

  it('reports a deleted local base as lost and forgets it', async () => {
    git(repo.path, 'branch', 'feat/base', 'main')
    store.setBranchBase(repo.path, 'feat/child', 'feat/base')
    git(repo.path, 'branch', '-D', 'feat/base')
    expect(await branchBaseAt(store, repo.path)).toEqual({ lost: 'feat/base' })
    expect(store.branchBase(repo.path, 'feat/child')).toBeUndefined()
    expect(await branchBaseAt(store, repo.path)).toBeNull()
  })

  it('keeps a remote base', async () => {
    git(repo.path, 'push', 'origin', 'main:refs/heads/x')
    git(repo.path, 'fetch', 'origin')
    store.setBranchBase(repo.path, 'feat/child', 'origin/x')
    expect(await branchBaseAt(store, repo.path)).toEqual({ base: 'origin/x' })
    expect(store.branchBase(repo.path, 'feat/child')).toBe('origin/x')
  })
})
