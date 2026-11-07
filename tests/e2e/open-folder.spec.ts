import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

let a: TestRepo
let b: TestRepo
let userData: string
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  a = await createRepo({ dirName: 'repo-a' })
  b = await createRepo({ dirName: 'repo-b' })
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [a.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', SHELL: '/bin/bash' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.locator('.repo-picker > button .name')).toHaveText('repo-a', { timeout: 20_000 })
})

test.afterEach(async () => {
  await closeApp(app).catch(() => undefined)
  await a.cleanup()
  await b.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const openFile = (path: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, p) => { electronApp.emit('open-file', { preventDefault() { /* as Electron's event */ } }, p) }, path)

test('a folder opened from the terminal switches to it, and a session started before keeps running', async () => {
  const composer = page.getByLabel(/^Message à Claude/)
  await composer.fill('lent')
  await composer.press('Meta+Enter')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Faire confiance' }).click().catch(() => undefined)
  await expect(page.getByTestId('session-state')).toHaveText('en cours')

  await openFile(b.path)
  await expect(page.locator('.repo-picker > button .name')).toHaveText('repo-b')
  await expect(page.getByTestId('user-message')).toHaveCount(0)
  expect(await page.evaluate((p) => window.canopy.sessionActivity(p), a.path)).toBe('working')

  // Back in A, the session went on.
  await openFile(a.path)
  await expect(page.locator('.repo-picker > button .name')).toHaveText('repo-a')
  await expect(page.getByTestId('assistant-message')).toContainText('mot40', { timeout: 15_000 })
  await expect(page.getByTestId('session-state')).toHaveText('prête')
})

test('a folder without a repo shows the open error and keeps the current one', async () => {
  await openFile(userData)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('.repo-picker > button .name')).toHaveText('repo-a')
})
