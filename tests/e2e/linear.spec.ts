import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

// Runs against the replay fake (`CANOPY_FAKE_LINEAR`): never the real Linear server. Always a temp user-data-dir.
let repo: TestRepo
let userData: string
let app: ElectronApplication | undefined
let page: Page

const FIXTURES = resolve('tests/fixtures/linear')
const MCP_NOTE = 'Le reste du ticket (commentaires, sous-tickets, pièces jointes) est accessible via le MCP Linear.'
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

const calls = (): string => join(userData, 'fake-linear-calls.jsonl')
const failFlag = (): string => join(userData, 'fake-linear-down')
const colleagueFile = (): string => join(userData, 'fake-linear-colleague.json')

async function launch(): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = {
    ...process.env,
    CANOPY_FAKE_QUERY: '1',
    CANOPY_FAKE_LINEAR: FIXTURES,
    CANOPY_FAKE_LINEAR_LOG: calls(),
    CANOPY_FAKE_LINEAR_FAIL: failFlag(),
    CANOPY_FAKE_LINEAR_COLLEAGUE: colleagueFile()
  } as Record<string, string>
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
const desc = (): Locator => page.getByPlaceholder('Décris le ticket en Markdown…')

async function saveCalls(): Promise<{ args: Record<string, unknown> }[]> {
  const text = await readFile(calls(), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> })
    .filter((c) => (c as { tool: string }).tool === 'save_issue')
}

async function openList(): Promise<void> {
  await nav('Tickets').click()
  await expect(page.getByTestId('ticket-linear-CAN-1')).toBeVisible({ timeout: 15_000 })
}

async function openLinear(id: string): Promise<void> {
  await openList()
  await page.getByTestId(`ticket-linear-${id}`).click()
  await expect(page.getByRole('navigation', { name: "Fil d'Ariane" })).toContainText(id)
  await expect(desc()).not.toHaveValue('')
}

/** The description with its first line changed, so the edit is a small patch. */
async function editFirstLine(to: string): Promise<void> {
  const before = await desc().inputValue()
  await desc().fill(before.replace('Welcome to Linear!', to))
}

test('list shows Linear and local rows; same id gives two rows, each with its editor', async () => {
  await launch()
  await page.evaluate(async (r) => {
    await window.canopy.setTicketPrefix(r, 'CAN')
    await window.canopy.createTicket(r, { title: 'Ticket local', description: 'local', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
  }, repo.path)
  await openList()

  const local = page.getByTestId('ticket-CAN-1')
  const remote = page.getByTestId('ticket-linear-CAN-1')
  await expect(local).toContainText('Ticket local')
  await expect(local.locator('.source-badge')).toHaveText('Local')
  await expect(remote).toContainText('Get familiar with Linear')
  await expect(remote.locator('.source-badge')).toHaveText('Linear')
  for (const id of ['CAN-2', 'CAN-3', 'CAN-4']) await expect(page.getByTestId(`ticket-linear-${id}`)).toBeVisible()

  await remote.click()
  await expect(page.getByLabel('Titre', { exact: true })).toHaveValue('Get familiar with Linear')
  await expect(page.getByRole('navigation', { name: "Fil d'Ariane" })).toContainText('Linear')
  await page.getByRole('button', { name: 'Retour' }).click()
  await local.click()
  await expect(page.getByLabel('Titre', { exact: true })).toHaveValue('Ticket local')
  await expect(page.getByRole('navigation', { name: "Fil d'Ariane" })).not.toContainText('Linear')
})

test('source filter and search', async () => {
  await launch()
  await page.evaluate(async (r) => {
    await window.canopy.setTicketPrefix(r, 'CAN')
    await window.canopy.createTicket(r, { title: 'Ticket local', description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
  }, repo.path)
  await openList()
  await expect(page.getByTestId('ticket-CAN-1')).toBeVisible()

  const filters = page.getByTestId('linear-filters')
  await filters.getByRole('button', { name: 'Linear', exact: true }).click()
  await expect(page.getByTestId('ticket-CAN-1')).toHaveCount(0)
  await expect(page.getByTestId('ticket-linear-CAN-2')).toBeVisible()

  await filters.getByRole('button', { name: 'Toutes sources' }).click()
  await page.getByLabel('Rechercher un ticket').fill('get familiar')
  await expect(page.getByTestId('ticket-linear-CAN-1')).toBeVisible()
  await expect(page.getByTestId('ticket-linear-CAN-2')).toHaveCount(0)
  await expect(page.getByTestId('ticket-CAN-1')).toHaveCount(0)
})

test('editing a description sends one save_issue with a patch', async () => {
  await launch()
  await openLinear('CAN-1')
  await editFirstLine('Welcome to Canopy!')
  await expect.poll(saveCalls).toHaveLength(0)
  await page.getByLabel('Titre', { exact: true }).focus()

  await expect.poll(saveCalls).toHaveLength(1)
  const [call] = await saveCalls()
  expect(call.args.id).toBe('CAN-1')
  expect(call.args.patch).toBeTruthy()
  expect(call.args).not.toHaveProperty('description')
  await expect(page.locator('.editor-unsent')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(await saveCalls()).toHaveLength(1)
})

test('a failed send stays pending across an offline restart, then goes on ⟳ once Linear is back', async () => {
  await launch()
  await openLinear('CAN-1')
  await writeFile(failFlag(), '')
  await editFirstLine('Welcome to Canopy!')
  await page.getByLabel('Titre', { exact: true }).focus()
  await expect(page.locator('.editor-unsent .pending-mark')).toHaveText('non envoyé')
  expect(await saveCalls()).toHaveLength(0)
  await page.getByRole('button', { name: 'Retour' }).click()
  await expect(page.getByTestId('ticket-linear-CAN-1').locator('.pending-mark')).toHaveText('non envoyé')

  // Restarted while Linear is unreachable: the cached list shows, with why it is stale.
  await closeApp(app!)
  await launch()
  await openList()
  await expect(page.getByTestId('ticket-linear-CAN-1').locator('.pending-mark')).toHaveText('non envoyé')
  await expect(page.getByTestId('linear-sync')).toContainText(/Linear · liste du \d\d:\d\d — Linear injoignable/)
  expect(await saveCalls()).toHaveLength(0)
  // The tokens are stored: Settings never asks to connect.
  await page.getByRole('button', { name: 'Réglages' }).click()
  const settings = page.getByTestId('linear-settings')
  await expect(settings).toContainText('Linear injoignable')
  await expect(settings.getByRole('button', { name: 'Déconnecter', exact: true })).toBeVisible()
  await expect(settings).not.toContainText('Connecter Linear')
  await page.keyboard.press('Escape')

  // Linear is back: ⟳ tries the stored tokens again, the list is fresh and the queued edit goes.
  await rm(failFlag())
  await page.getByRole('button', { name: 'Rafraîchir Linear' }).click()
  await expect(page.getByTestId('linear-sync')).toContainText('synchro à l’instant')
  await expect.poll(saveCalls).toHaveLength(1)
  expect((await saveCalls())[0].args.patch).toBeTruthy()
  await expect(page.getByTestId('ticket-linear-CAN-1').locator('.pending-mark')).toHaveCount(0)
})

test('a colleague edit of the same passage shows the conflict; keeping mine resends', async () => {
  await launch()
  await openLinear('CAN-1')
  await editFirstLine('Welcome to Canopy!')
  await writeFile(colleagueFile(), JSON.stringify({
    id: 'CAN-1',
    description: (await desc().inputValue()).replace('Welcome to Canopy!', 'Hello from a colleague!')
  }))
  await page.getByLabel('Titre', { exact: true }).focus()

  const conflict = page.getByRole('region', { name: 'Conflit sur la description' })
  await expect(conflict).toBeVisible()
  await expect(conflict.locator('pre').first()).toContainText('Hello from a colleague!')
  await expect(conflict.locator('pre').nth(1)).toContainText('Welcome to Canopy!')
  const before = (await saveCalls()).length

  await conflict.getByRole('button', { name: 'Garder la mienne' }).click()
  await expect.poll(async () => (await saveCalls()).length).toBe(before + 1)
  await expect(conflict).toHaveCount(0)
  await expect(desc()).toHaveValue(/Welcome to Canopy!/)
  const last = (await saveCalls()).at(-1)!
  expect(JSON.stringify(last.args)).toContain('Welcome to Canopy!')
  // The fake's final description is Bastien's: reading it back through the app shows it.
  const read = await page.evaluate(() => window.canopy.linearIssue('CAN-1'))
  expect(read.description).toContain('Welcome to Canopy!')
  expect(read.description).not.toContain('Hello from a colleague!')
})

test('launch a Linear ticket in a new worktree', async () => {
  await launch()
  await openList()
  await page.getByTestId('ticket-linear-CAN-1').getByRole('button', { name: /Lancer/ }).click()
  await page.getByRole('button', { name: /^Lancer CAN-1/ }).click()

  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('worktree').filter({ hasText: 'feat/can-1-get-familiar-with-linear' })).toBeVisible()
  await expect(page.getByTestId('user-message').first()).toContainText(MCP_NOTE)
  expect(git(repo.path, 'branch', '--list', 'feat/can-1-get-familiar-with-linear')).toContain('feat/can-1-get-familiar-with-linear')
})

test('settings show the account; disconnecting with a pending edit asks first', async () => {
  await launch()
  await openLinear('CAN-1')
  await writeFile(failFlag(), '')
  await editFirstLine('Welcome to Canopy!')
  await page.getByLabel('Titre', { exact: true }).focus()
  await expect(page.locator('.editor-unsent .pending-mark')).toBeVisible()

  await page.getByRole('button', { name: 'Réglages' }).click()
  const settings = page.getByTestId('linear-settings')
  await expect(settings.getByTestId('linear-account')).toHaveText('canopy · bastien.pailloux@hotmail.fr')
  await settings.getByRole('button', { name: 'Déconnecter', exact: true }).click()
  await expect(settings).toContainText('Déconnecter quand même ?')
  await expect(settings.getByTestId('linear-account')).toBeVisible()
})
