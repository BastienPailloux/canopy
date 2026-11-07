import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
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
const ALPHA = 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport function total(): number {\n  return a + b + c\n}\n'

test.beforeEach(async () => {
  repo = await createRepo()
  await repo.commit('src/alpha.ts', ALPHA)
  await repo.commit('src/beta.ts', 'import { total } from "./alpha"\nexport const beta = total()\n')
  featPath = join(repo.path, '.worktrees', 'feat-a')
  execFileSync('git', ['worktree', 'add', '-b', 'feat/a', featPath, 'main'], { cwd: repo.path, env: GIT_ENV })
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(2, { timeout: 20_000 })
  await page.getByTestId('worktree').filter({ hasText: 'feat/a' }).click()
})

test.afterEach(async () => {
  await app.close()
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name, exact: true })

test('⇧⌘F lists the calls of a function, and a click opens the file at that line', async () => {
  await nav('Code').click()
  await page.keyboard.press('Meta+Shift+f')
  await expect(page.getByLabel('Rechercher dans le projet')).toBeFocused()
  await page.keyboard.type('total')

  const hits = page.getByTestId('search-hit')
  await expect(hits).toHaveCount(3)
  await hits.filter({ hasText: 'function total' }).click()

  await expect(page.getByTestId('code-editor')).toContainText('export function total')
  await expect(page.locator('.active-line-number')).toHaveText('4')
  // The results stay there for the next click.
  await expect(hits).toHaveCount(3)

  await page.getByLabel('Rechercher dans le projet').fill('(')
  await page.getByRole('button', { name: 'Expression régulière' }).click()
  await expect(page.getByTestId('search-error')).toContainText('Expression régulière invalide')
})

test('⌘K opens a file or a line from anywhere, and leaves the composer alone', async () => {
  await nav('Sessions').click()
  const composer = page.locator('#composer')
  await composer.click()
  await composer.fill('brouillon')

  await page.keyboard.press('Meta+k')
  const bar = page.getByRole('dialog', { name: 'Barre de commandes' })
  await expect(bar).toBeVisible()
  await page.keyboard.type('beta')
  await expect(bar.getByTestId('cmdbar-files').getByTestId('cmdbar-item').first()).toContainText('src/beta.ts')
  await expect(composer).toHaveValue('brouillon')

  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(composer).toBeFocused()

  await page.keyboard.press('Meta+k')
  await page.keyboard.type('total()')
  const text = bar.getByTestId('cmdbar-text').getByTestId('cmdbar-item')
  await expect(text).toHaveCount(2)
  await page.keyboard.press('ArrowDown')
  await expect(bar.getByRole('option', { selected: true })).toContainText('beta.ts:2')
  await page.keyboard.press('Enter')

  await expect(bar).toHaveCount(0)
  await expect(nav('Code')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('code-editor')).toContainText('export const beta')
  await expect(page.locator('.active-line-number')).toHaveText('2')
})
