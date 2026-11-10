import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { createWorktree } from '../../../src/main/git/worktrees'
import { approveConfig, repoTrust } from '../../../src/main/repoTrust'
import { launchConfig, saveLaunchConfig } from '../../../src/main/terminal/launchConfig'
import { isRepoNotTrusted } from '../../../src/shared/errors'
import { createRepo, type TestRepo } from '../../helpers/repo'

let dir: string
let repo: TestRepo
let store: AppStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-launch-'))
  repo = await createRepo()
  store = new AppStore(join(dir, 'state.json'))
})
afterEach(async () => {
  await repo.cleanup()
  await rm(dir, { recursive: true, force: true })
})

const SETTINGS = { setup: ['make deps'], services: [{ name: 'api', command: 'make run', portEnv: 'PORT' }] }

const writeFileConfig = async (cwd: string): Promise<void> => {
  await mkdir(join(cwd, '.canopy'), { recursive: true })
  await writeFile(join(cwd, '.canopy', 'config.json'), JSON.stringify({ services: [{ name: 'web', command: 'npm run dev' }] }))
}

test('without a setting, the file is used once the repo approved it', async () => {
  await writeFileConfig(repo.path)
  expect(isRepoNotTrusted(await launchConfig(store, repo.path).catch((e: unknown) => e))).toBe(true)
  await approveConfig(store, repo.path, (await repoTrust(store, repo.path)).configHash)
  expect((await launchConfig(store, repo.path)).services.map((s) => s.name)).toEqual(['web'])
})

test('the setting of the repo replaces the file in all its worktrees, with no approval', async () => {
  await writeFileConfig(repo.path)
  const wt = await createWorktree(repo.path, { name: 'alpha', branch: 'feat/alpha', base: 'main', parentDir: dir })
  store.setLaunchConfig(repo.path, SETTINGS)
  expect(await launchConfig(store, repo.path)).toEqual(SETTINGS)
  expect(await launchConfig(store, wt.path)).toEqual(SETTINGS)
})

test('a folder that is not a worktree of the repo does not get its setting', async () => {
  store.setLaunchConfig(repo.path, SETTINGS)
  const other = await createRepo()
  try {
    expect(isRepoNotTrusted(await launchConfig(store, other.path).catch((e: unknown) => e))).toBe(true)
  } finally {
    await other.cleanup()
  }
})

test('a setting saved from a worktree belongs to its repo', async () => {
  const wt = await createWorktree(repo.path, { name: 'alpha', branch: 'feat/alpha', base: 'main', parentDir: dir })
  await saveLaunchConfig(store, wt.path, { setup: [], services: [{ name: 'web', command: 'npm run dev' }] })
  expect(store.launchConfig(repo.path)).toEqual({ setup: [], services: [{ name: 'web', command: 'npm run dev', portEnv: 'PORT' }] })
  await saveLaunchConfig(store, wt.path, null)
  expect(store.launchConfig(repo.path)).toBeNull()
})

test('a setting is checked like the file before it is saved', async () => {
  await expect(saveLaunchConfig(store, repo.path, { services: [{ name: 'web', command: 'x', portEnv: 'ZDOTDIR' }] })).rejects.toThrow(/^Réglage invalide/)
  expect(store.launchConfig(repo.path)).toBeNull()
})

test('an empty setting is no setting: the file applies again', async () => {
  store.setLaunchConfig(repo.path, SETTINGS)
  await saveLaunchConfig(store, repo.path, { setup: [], services: [] })
  expect(store.launchConfig(repo.path)).toBeNull()
})

test('a setting too big to be typed is refused', async () => {
  const huge = { setup: ['x'.repeat(70_000)], services: [] }
  await expect(saveLaunchConfig(store, repo.path, huge)).rejects.toThrow(/Réglage invalide : trop long/)
  expect(store.launchConfig(repo.path)).toBeNull()
})

test('the size cap counts bytes, not characters', async () => {
  // 40 000 characters, 120 000 bytes in UTF-8.
  await expect(saveLaunchConfig(store, repo.path, { setup: ['€'.repeat(40_000)], services: [] })).rejects.toThrow(/Réglage invalide : trop long/)
})

test('a missing setting gets the readable error, not a crash', async () => {
  await expect(saveLaunchConfig(store, repo.path, undefined)).rejects.toThrow(/^Réglage invalide : un objet est attendu/)
})
