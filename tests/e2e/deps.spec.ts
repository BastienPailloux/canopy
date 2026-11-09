import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

// Replays the captured OSV/registry answers (`CANOPY_FAKE_DEPS`): never the network. Always a temp user-data-dir.
const FIXTURES = resolve('tests/fixtures/deps')
const VERSIONS: Record<string, string> = { tar: '6.1.11', request: '2.88.2', electron: '33.2.0', zustand: '5.0.1' }
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Canopy Test', GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test', GIT_COMMITTER_EMAIL: 'test@canopy.local',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

let withDeps: TestRepo
let clean: TestRepo
let userData: string
let app: ElectronApplication | undefined
let page: Page

/** Commits package.json + a v3 lockfile on main and pushes them: the check reads origin's base branch. */
async function addLockfile(repo: TestRepo): Promise<void> {
  const dependencies = Object.fromEntries(Object.entries(VERSIONS).map(([n, v]) => [n, `^${v}`]))
  const packages: Record<string, unknown> = { '': { name: 'fixture', version: '1.0.0', dependencies } }
  for (const [n, v] of Object.entries(VERSIONS)) packages[`node_modules/${n}`] = { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }
  await repo.commit('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies }, null, 2))
  await repo.commit('package-lock.json', JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2))
  git(repo.path, 'push', 'origin', 'main')
}

async function launch(recent: string[]): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: recent, ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', CANOPY_FAKE_DEPS: FIXTURES } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree').first()).toBeVisible({ timeout: 20_000 })
}

test.beforeEach(async () => {
  withDeps = await createRepo({ remote: true, dirName: 'with-deps' })
  clean = await createRepo({ remote: true, dirName: 'clean' })
  await addLockfile(withDeps)
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
})

test.afterEach(async () => {
  if (app) await closeApp(app).catch(() => undefined)
  app = undefined
  await withDeps.cleanup()
  await clean.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name })
const banner = (): Locator => page.getByTestId('deps-banner')

test('critical dependencies raise a banner and a badge, dismissed for good', async () => {
  await launch([withDeps.path])
  await expect(banner()).toContainText('2 dépendances critiques', { timeout: 30_000 })
  await expect(page.getByTestId('deps-count')).toHaveText('2')

  await banner().getByRole('button', { name: 'Voir' }).click()
  await expect(nav('Dépendances')).toHaveAttribute('aria-current', 'page')
  const checked = (n: string): Locator => page.getByRole('checkbox', { name: `Sélectionner ${n}` })
  await expect(checked('tar')).toBeChecked()
  await expect(checked('request')).toBeChecked()
  await expect(checked('electron')).not.toBeChecked()
  await expect(checked('zustand')).not.toBeChecked()

  await banner().getByRole('button', { name: "Fermer l'alerte" }).click()
  await expect(banner()).toHaveCount(0)
  await expect(page.getByTestId('deps-count')).toHaveText('2')

  await closeApp(app!)
  app = undefined
  await launch([withDeps.path])
  await expect(page.getByTestId('deps-count')).toHaveText('2', { timeout: 30_000 })
  await expect(banner()).toHaveCount(0)
})

test('the picker flags another repo with critical dependencies', async () => {
  await launch([clean.path, withDeps.path])
  await expect(page.locator('.repo-picker > button .name')).toHaveText('clean')
  await expect(page.locator('.repo-picker > button').getByTestId('repo-deps-alert')).toBeVisible({ timeout: 30_000 })
  await expect(banner()).toHaveCount(0)
})

test('banner follows the displayed repo', async () => {
  await launch([withDeps.path, clean.path])
  await expect(banner()).toContainText('2 dépendances critiques', { timeout: 30_000 })
  await page.locator('.repo-picker > button').click()
  await page.getByRole('menuitem', { name: /clean/ }).click()
  await expect(page.locator('.repo-picker > button .name')).toHaveText('clean')
  await expect(banner()).toHaveCount(0)
  await expect(page.getByTestId('deps-count')).toHaveCount(0)
})

test('launch Claude on the critical updates in a new worktree', async () => {
  await launch([withDeps.path])
  await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), withDeps.path)
  await expect(banner()).toContainText('2 dépendances critiques', { timeout: 30_000 })
  await banner().getByRole('button', { name: 'Voir' }).click()
  await page.getByTestId('deps-launch').click()

  const dialog = page.getByTestId('deps-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Nom de la branche')).toHaveValue(/^fix\/deps-/)
  await dialog.getByRole('button', { name: 'Lancer', exact: true }).click()

  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('worktree').filter({ hasText: 'fix/deps-' })).toBeVisible({ timeout: 30_000 })
  const first = page.getByTestId('user-message').first()
  await expect(first).toContainText('tar')
  await expect(first).toContainText('request')
})
