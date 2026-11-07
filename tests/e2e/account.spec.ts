import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

const git = promisify(execFile)
const SHOT = process.env.CANOPY_ACCOUNT_SHOT

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page

// Fake data only: the runner is replaced through the environment, as the fake query is.
const FAKE = { loggedIn: true, authMethod: 'claude.ai', email: 'ada.lovelace@example.test', orgName: 'Mon org', subscriptionType: 'max' }

test.beforeEach(async () => {
  repo = await createRepo({ dirName: 'repo-a' })
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', CANOPY_FAKE_ACCOUNT: JSON.stringify(FAKE), SHELL: '/bin/bash' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.locator('.repo-picker > button .name')).toHaveText('repo-a', { timeout: 20_000 })
})

test.afterEach(async () => {
  await closeApp(app).catch(() => undefined)
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

test('the sidebar footer shows the account and stays visible beside a long worktree list', async () => {
  const parent = join(repo.path, '..', 'wts')
  await mkdir(parent)
  for (let i = 0; i < 25; i++) await git('git', ['worktree', 'add', '-b', `feature-${i}`, join(parent, `feature-${i}`)], { cwd: repo.path })
  await page.reload()
  await expect(page.locator('.wt')).toHaveCount(26, { timeout: 20_000 })

  await expect(page.getByTestId('account-line1')).toHaveText('ada.lovelace@example.test')
  await expect(page.getByTestId('account-line1')).toHaveAttribute('title', 'ada.lovelace@example.test')
  await expect(page.getByTestId('account-line2')).toHaveText('Claude Max · Mon org')
  await expect(page.locator('.account .avatar')).toHaveText('AL')

  const footer = (await page.getByTestId('account').boundingBox())!
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(footer.y + footer.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(footer.x).toBeLessThan(40)
  // The list scrolls, the page does not.
  expect(await page.locator('.wt-list').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  if (SHOT) await page.screenshot({ path: SHOT })
})
