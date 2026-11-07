import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Canopy Test',
  GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test',
  GIT_COMMITTER_EMAIL: 'test@canopy.local'
}

test.beforeEach(async () => {
  repo = await createRepo()
  execFileSync('git', ['worktree', 'add', '-b', 'feat/side-rail', join(repo.path, '.worktrees', 'side-rail'), 'main'], { cwd: repo.path, env: GIT_ENV })
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(2, { timeout: 20_000 })
})

test.afterEach(async () => {
  await closeApp(app).catch(() => undefined)
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

/** Drags the middle of `handle` sideways by `dx` pixels. */
async function drag(handle: Locator, dx: number): Promise<void> {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

const width = async (l: Locator): Promise<number> => (await l.boundingBox())!.width

test('the worktree list is widened by its edge, turns into a rail when dragged too narrow, and comes back', async () => {
  const sidebar = page.getByRole('complementary', { name: 'Worktrees' })
  const edge = page.getByRole('separator', { name: 'Largeur des worktrees' })
  expect(await width(sidebar)).toBeCloseTo(256, -1)

  await drag(edge, 100)
  expect(await width(sidebar)).toBeCloseTo(356, -1)

  await drag(edge, -400)
  await expect(sidebar).toHaveAttribute('data-rail', 'true')
  expect(await width(sidebar)).toBeLessThan(70)
  // Every worktree still reachable, named on hover.
  const railRows = page.getByTestId('worktree')
  await expect(railRows).toHaveCount(2)
  await expect(railRows.nth(1)).toHaveAttribute('title', /feat\/side-rail/)
  await expect(railRows.nth(1)).toHaveText('SR')
  await railRows.nth(1).click()
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/side-rail')

  // Kept across a restart of the page.
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Worktrees' })).toHaveAttribute('data-rail', 'true', { timeout: 20_000 })

  await drag(page.getByRole('separator', { name: 'Largeur des worktrees' }), 300)
  await expect(sidebar).not.toHaveAttribute('data-rail', 'true')
  expect(await width(sidebar)).toBeGreaterThanOrEqual(200)
})

test('the side panel is widened by its edge, kept on reload, and reset by a double click', async () => {
  const panel = page.getByRole('complementary', { name: 'Panneau latéral' })
  const edge = page.getByRole('separator', { name: 'Largeur du panneau latéral' })
  await expect(panel).toBeVisible()
  const before = await width(panel)

  await drag(edge, -120)
  expect(await width(panel)).toBeCloseTo(before + 120, -1)

  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Panneau latéral' })).toBeVisible({ timeout: 20_000 })
  expect(await width(panel)).toBeCloseTo(before + 120, -1)

  await page.getByRole('separator', { name: 'Largeur du panneau latéral' }).dblclick()
  expect(await width(panel)).toBeCloseTo(300, -1)
})

test('the edges move with the keyboard', async () => {
  const sidebar = page.getByRole('complementary', { name: 'Worktrees' })
  const edge = page.getByRole('separator', { name: 'Largeur des worktrees' })
  await edge.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  expect(await width(sidebar)).toBeCloseTo(288, -1)
})
