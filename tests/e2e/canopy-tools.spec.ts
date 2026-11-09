import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

// Claude's tool calls go through the in-process `canopy` MCP server, driven here by the fake query (no real session).
let repo: TestRepo
let userData: string
let app: ElectronApplication | undefined
let page: Page

async function launch(linear: boolean): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', ...(linear ? { CANOPY_FAKE_LINEAR: resolve('tests/fixtures/linear') } : {}) } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree').first()).toBeVisible({ timeout: 20_000 })
  await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), repo.path)
}

test.beforeEach(async () => {
  repo = await createRepo()
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
})

test.afterEach(async () => {
  if (app) await closeApp(app).catch(() => undefined)
  app = undefined
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name })
const composer = (): Locator => page.getByLabel(/^Message à Claude/)

async function send(text: string): Promise<void> {
  await composer().fill(text)
  await composer().press('Meta+Enter')
}

test('a sub-ticket created by Claude shows up under its parent', async () => {
  await launch(false)
  const parent = await page.evaluate((r) => window.canopy.createTicket(r, {
    title: 'Export', description: '', status: 'backlog', priority: 'none', labels: [], subtasks: []
  }), repo.path)
  await send(`canopy create_ticket {"source":"local","title":"Export CSV","parent":"local:${parent.id}"}`)
  await expect(page.getByTestId('assistant-message').last()).toContainText('Outil terminé.', { timeout: 15_000 })

  await nav('Tickets').click()
  const child = page.getByRole('row', { name: /Export CSV/ })
  await expect(child).toContainText(parent.id)
  await page.getByTestId(`ticket-${parent.id}`).click()
  await expect(page.getByRole('region', { name: 'Sous-tickets' })).toContainText('Export CSV')
})

test('a Linear sub-issue created by Claude appears in the Linear list', async () => {
  await launch(true)
  await send('canopy create_ticket {"source":"linear","title":"Export PDF","parent":"linear:CAN-3"}')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Outil terminé.', { timeout: 15_000 })

  await nav('Tickets').click()
  await expect(page.getByTestId('ticket-linear-CAN-1')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Export PDF').first()).toBeVisible({ timeout: 15_000 })
})
