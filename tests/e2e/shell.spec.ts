import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../helpers/repo'

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page
let featPath: string

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Canopy Test',
  GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test',
  GIT_COMMITTER_EMAIL: 'test@canopy.local'
}

test.beforeEach(async () => {
  repo = await createRepo()
  featPath = join(repo.path, '.worktrees', 'feat-a')
  execFileSync('git', ['worktree', 'add', '-b', 'feat/a', featPath, 'main'], { cwd: repo.path, env: GIT_ENV })
  await writeFile(join(featPath, 'dirty.txt'), 'uncommitted\n')

  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))

  // The shell may export ELECTRON_RUN_AS_NODE=1, which would make Electron behave as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
})

test.afterEach(async () => {
  await app.close()
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const rows = (): ReturnType<Page['getByTestId']> => page.getByTestId('worktree')

test('lists both worktrees and switches the active one on click', async () => {
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  await expect(page.getByTestId('active-worktree')).toHaveText('main')
  await expect(page.getByText('+1', { exact: true })).toBeVisible() // dirty.txt on feat/a

  await rows().filter({ hasText: 'feat/a' }).click()
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/a')
  await expect(rows().filter({ hasText: 'feat/a' })).toHaveAttribute('aria-current', 'true')
  await expect(rows().filter({ hasText: 'main' })).toHaveAttribute('aria-current', 'false')
})

test('creating a worktree adds it to the list and selects it', async () => {
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Nouveau worktree' }).click()
  await page.getByLabel('Nom de la branche').fill('feat/b')
  await page.getByRole('button', { name: 'Créer', exact: true }).click()
  await expect(rows()).toHaveCount(3)
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/b')
})

test('a new worktree takes a chosen base and location', async () => {
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  const dir = join(userData, 'ailleurs')
  await page.getByRole('button', { name: 'Nouveau worktree' }).click()
  await page.getByLabel('Nom de la branche').fill('feat/c')
  await page.getByLabel('Base').selectOption('feat/a')
  await page.getByLabel('Emplacement').fill(dir)
  await page.getByRole('button', { name: 'Créer', exact: true }).click()
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/c')
  await expect(rows().filter({ hasText: 'feat/c' })).toHaveAttribute('data-path', new RegExp(`ailleurs/feat-c$`))
})

test('a worktree can open an existing branch', async () => {
  execFileSync('git', ['branch', 'pr/teammate', 'main'], { cwd: repo.path, env: GIT_ENV })
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Nouveau worktree' }).click()
  await page.getByLabel('Utiliser une branche existante').check()
  await page.getByLabel('Branche', { exact: true }).selectOption('pr/teammate')
  await page.getByRole('button', { name: 'Créer', exact: true }).click()
  await expect(page.getByTestId('active-worktree')).toHaveText('pr/teammate')
})

test('removing a dirty worktree asks for confirmation and shows the risk', async () => {
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  await rows().filter({ hasText: 'feat/a' }).hover()
  await page.getByRole('button', { name: 'Supprimer feat/a' }).click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByTestId('removal-risk')).toContainText('1 fichier non commité')
  await expect(rows()).toHaveCount(2) // nothing removed before confirmation

  await dialog.getByRole('button', { name: 'Annuler' }).click()
  await expect(rows()).toHaveCount(2)

  await rows().filter({ hasText: 'feat/a' }).hover()
  await page.getByRole('button', { name: 'Supprimer feat/a' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer quand même' }).click()
  await expect(rows()).toHaveCount(1)
})

test('a worktree whose stats fail keeps its last stats and shows an error, the list survives', async () => {
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  const feat = rows().filter({ hasText: 'feat/a' })
  await expect(feat).toContainText('+1')

  // Break the worktree's gitdir pointer: git can no longer read it.
  await writeFile(join(featPath, '.git'), 'gitdir: /nonexistent/canopy\n')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  await expect(feat.getByTestId('worktree-error')).toHaveText('données périmées')
  await expect(feat).toContainText('+1') // last good stats kept
  await expect(rows()).toHaveCount(2)
  await expect(rows().filter({ hasText: 'main' }).getByTestId('worktree-error')).toHaveCount(0)
})

test('loads bundled fonts and raises no CSP violation', async () => {
  const messages: string[] = []
  page.on('console', (m) => messages.push(m.text()))
  await page.reload()
  await expect(rows()).toHaveCount(2, { timeout: 20_000 })
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return ['Inter', 'JetBrains Mono', 'Space Grotesk'].map((f) => document.fonts.check(`12px "${f}"`))
  })
  expect(fonts).toEqual([true, true, true])
  expect(messages.filter((m) => /Content Security Policy|Refused/.test(m))).toEqual([])
})

test('trusting a repo approves the config it listed, not the other configs of its worktrees', async () => {
  await writeFile(join(repo.path, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
  const trust = await page.evaluate((r) => window.canopy.repoTrust(r), repo.path)
  expect(trust).toEqual({
    trusted: false, configHash: trust.configHash, setup: [], services: [], hooks: [], mcpServers: ['db: db-mcp'], allowRules: [], apiKeyHelper: [],
    statusLine: [], env: [], settingsKeys: [], unknownFiles: []
  })
  // Refused before any process starts, so this runs no Claude session.
  const refusal = await page.evaluate((r) => window.canopy.startSession(r, { content: { text: 'hi' } }).catch((e: Error) => e.message), repo.path)
  expect(refusal).toContain('REPO_NOT_TRUSTED')
  await page.evaluate(([r, hash]) => window.canopy.trustRepo(r, hash), [repo.path, trust.configHash])
  expect((await page.evaluate((r) => window.canopy.repoTrust(r), repo.path)).trusted).toBe(true)
  // Its worktree does not have that .mcp.json: another config, another approval.
  expect((await page.evaluate((r) => window.canopy.repoTrust(r), featPath)).trusted).toBe(false)
  expect(await page.evaluate(() => window.canopy.pendingPermissions())).toEqual([])
})
