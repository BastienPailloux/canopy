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
  execFileSync('git', ['worktree', 'add', '-b', 'feat/a', join(repo.path, '.worktrees', 'feat-a'), 'main'], { cwd: repo.path, env: GIT_ENV })
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(2, { timeout: 20_000 })
  await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), repo.path)
})

test.afterEach(async () => {
  await closeApp(app)
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

// Playwright's keys reach the page, not the macOS menu: a shortcut is fired as the menu would, by clicking its entry.
const press = async (id: string): Promise<void> => {
  await app.evaluate(({ Menu }, itemId) => { Menu.getApplicationMenu()?.getMenuItemById(`shortcut:${itemId}`)?.click() }, id)
}

// Tickets carries a count once one is open: its name starts with the label.
const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: new RegExp(`^${name}`) })

test('⌘1 to ⌘3 switch screens', async () => {
  await press('view-code')
  await expect(nav('Code')).toHaveAttribute('aria-current', 'page')
  await press('view-tickets')
  await expect(nav('Tickets')).toHaveAttribute('aria-current', 'page')
  await press('view-sessions')
  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
})

test('⌃⇥ goes to the next worktree and ⌃⇧⇥ back', async () => {
  await expect(page.getByTestId('active-worktree')).toHaveText('main')
  await press('worktree-next')
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/a')
  await press('worktree-previous')
  await expect(page.getByTestId('active-worktree')).toHaveText('main')
})

test('⌘T opens a new session tab on the Sessions screen', async () => {
  const tabs = page.getByRole('tablist', { name: 'Sessions du worktree' }).getByRole('tab')
  await expect(tabs).toHaveCount(1)
  await press('view-code')
  await press('new-session')
  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
  await expect(tabs).toHaveCount(2)
})

test('⌘⇧N opens the new worktree dialog from Tickets, and nothing changes behind it', async () => {
  await press('view-tickets')
  await press('new-worktree')
  await expect(page.getByLabel('Nom de la branche')).toBeVisible()
  await press('view-sessions')
  await expect(nav('Tickets')).toHaveAttribute('aria-current', 'page')
  await page.getByLabel('Nom de la branche').fill('feat/b')
  await page.getByRole('button', { name: 'Créer', exact: true }).click()
  await expect(page.getByLabel('Nom de la branche')).toBeHidden()
  await press('view-sessions')
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/b')
})

test('⌘⇧T creates a local ticket without leaving the screen', async () => {
  await press('view-code')
  await press('new-ticket')
  await page.getByLabel('Titre').fill('Idée rapide')
  await page.getByLabel('Description').fill('Notée depuis Code')
  await page.keyboard.press('Meta+Enter')
  const notice = page.getByTestId('quick-ticket-notice')
  await expect(notice).toBeVisible()
  await expect(nav('Code')).toHaveAttribute('aria-current', 'page')
  const list = await page.evaluate((r) => window.canopy.listTickets(r), repo.path)
  expect(list.some((e) => e.kind === 'ticket' && e.ticket.title === 'Idée rapide')).toBe(true)
  await notice.getByRole('button', { name: 'Ouvrir' }).click()
  await expect(nav('Tickets')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByLabel('Titre', { exact: true })).toHaveValue('Idée rapide')
})

test('⌘⇧H lists every shortcut', async () => {
  await press('help')
  const help = page.getByRole('dialog', { name: 'Raccourcis clavier' })
  await expect(help).toBeVisible()
  for (const [keys, label] of [['⌘1', 'Sessions'], ['⌃⇥', 'Worktree suivant'], ['⇧⌘N', 'Nouveau worktree…'], ['⌘T', 'Nouvelle session'], ['⇧⌘T', 'Nouveau ticket…'], ['⇧⌘D', 'Dicter un message'], ['⇧⌘H', 'Raccourcis clavier'], ['⌘K', 'Rechercher'], ['⌘W', "Fermer l'onglet"], ['⌃`', 'Terminal']]) {
    await expect(help.getByRole('row').filter({ hasText: keys }).filter({ hasText: label })).toHaveCount(1)
  }
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
})
