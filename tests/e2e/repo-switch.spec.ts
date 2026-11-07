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
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [a.path, b.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', SHELL: '/bin/bash' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(1, { timeout: 20_000 })
})

test.afterEach(async () => {
  await closeApp(app).catch(() => undefined)
  await a.cleanup()
  await b.cleanup()
  await rm(userData, { recursive: true, force: true })
})

async function pickRepo(name: string): Promise<void> {
  await page.locator('.repo-picker > button').click()
  await page.getByRole('menuitem', { name: new RegExp(name) }).click()
  await expect(page.locator('.repo-picker > button .name')).toHaveText(name)
}

test('a session and a terminal keep running in repo A while repo B is open, output kept', async () => {
  await expect(page.locator('.repo-picker > button .name')).toHaveText('repo-a')
  await expect(page.getByTestId('worktree-status')).toHaveText('Principal')

  const composer = page.getByLabel(/^Message à Claude/)
  await composer.fill('lent')
  await composer.press('Meta+Enter')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Faire confiance' }).click().catch(() => undefined)
  await expect(page.getByTestId('session-state')).toHaveText('en cours')
  await expect(page.getByTestId('assistant-message')).toContainText('mot1')

  await page.keyboard.press('Control+`')
  const panel = page.getByRole('region', { name: 'Terminal du worktree' })
  await expect(panel.locator('.xterm-rows')).toBeVisible({ timeout: 15_000 })
  await page.locator('.xterm-helper-textarea').click()
  await page.keyboard.type('echo kept=$((40+2))')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.xterm-rows')).toContainText('kept=42', { timeout: 15_000 })

  await pickRepo('repo-b')
  await expect(page.getByTestId('user-message')).toHaveCount(0)
  // B shows its own terminal, not A's.
  await expect(panel.locator('.xterm-rows')).not.toContainText('kept=42')
  expect(await page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.filter((t) => t.running).length), a.path)).toBe(1)
  expect(await page.evaluate((p) => window.canopy.sessionActivity(p), a.path)).toBe('working')

  await pickRepo('repo-a')
  await expect(page.getByTestId('user-message')).toHaveText(['lent'])
  await expect(page.getByTestId('assistant-message')).toContainText('mot40', { timeout: 15_000 })
  await expect(page.getByTestId('session-state')).toHaveText('prête')
  await expect(panel.getByRole('tab')).toHaveCount(1)
  await expect(panel.locator('.xterm-rows')).toContainText('kept=42')
  expect(await page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.filter((t) => t.running).length), a.path)).toBe(1)
})
