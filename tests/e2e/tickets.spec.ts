import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

async function launch(): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
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
  await closeApp(app)
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const nav = (name: string): Locator => page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name })
const ticketFile = (id = 'REP-1'): string => join(repo.path, '.tickets', `${id}.md`)

async function newTicket(title: string, description = ''): Promise<void> {
  await page.evaluate(([r, t, d]) => window.canopy.createTicket(r, {
    title: t, description: d, status: 'backlog', priority: 'none', labels: [], subtasks: []
  }), [repo.path, title, description])
}

async function openLaunchPanel(id: string): Promise<void> {
  await nav('Tickets').click()
  await page.getByTestId(`ticket-${id}`).click()
}

test('create and edit a ticket', async () => {
  await launch()
  await nav('Tickets').click()
  await page.getByRole('button', { name: '+ Nouveau ticket' }).click()
  await page.getByLabel('Titre', { exact: true }).fill('Ajouter la recherche')
  await page.getByPlaceholder('Décris le ticket en Markdown…').fill('Chercher dans les fichiers')
  await page.getByRole('region', { name: 'Sous-tâches' }).getByRole('button', { name: '+ Ajouter' }).click()
  await page.getByLabel('Nom de la sous-tâche').fill('Écrire le test')
  await page.getByLabel('Nom de la sous-tâche').press('Enter')
  await expect(page.getByRole('checkbox', { name: 'Écrire le test' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: "Fil d'Ariane" })).toContainText('REP-1')

  await page.getByRole('button', { name: 'Mes tickets', exact: true }).click()
  const group = page.getByRole('rowgroup', { name: 'Backlog' })
  await expect(group.getByTestId('ticket-REP-1')).toContainText('Ajouter la recherche')

  await expect.poll(async () => readFile(ticketFile(), 'utf8').catch(() => '')).toContain('Écrire le test')
  const text = await readFile(ticketFile(), 'utf8')
  expect(text).toContain('Ajouter la recherche')
  expect(text).toContain('Chercher dans les fichiers')
  expect(git(repo.path, 'status', '--porcelain')).toBe('')
})

test('launch into a new worktree', async () => {
  await launch()
  await newTicket('Corriger le bug', 'Il casse tout')
  await openLaunchPanel('REP-1')
  await page.getByRole('button', { name: /^Lancer REP-1/ }).click()

  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('worktree').filter({ hasText: 'feat/corriger-le-bug' })).toBeVisible()
  await expect(page.getByTestId('user-message').first()).toContainText('REP-1')
  await expect(page.getByTestId('assistant-message').first()).toContainText('REP-1')

  await nav('Tickets').click()
  await expect(page.getByRole('rowgroup', { name: 'En cours' }).getByTestId('ticket-REP-1')).toBeVisible()
  await expect(page.getByTestId('ticket-REP-1').getByRole('button', { name: 'feat/corriger-le-bug' })).toBeVisible()
})

test('launch into an existing worktree with uncommitted changes', async () => {
  const wt = join(repo.path, '.worktrees', 'feat-a')
  git(repo.path, 'worktree', 'add', '-b', 'feat/a', wt, 'main')
  await writeFile(join(wt, 'README.md'), '# dirty\n')
  await launch()
  await newTicket('Seconde tâche')
  await openLaunchPanel('REP-1')

  await page.getByRole('radio', { name: 'Worktree existant, nouvelle branche' }).check()
  await expect(page.locator('.launch-counts')).toHaveText('1 fichier mis de côté')
  await page.getByRole('button', { name: /^Lancer REP-1/ }).click()

  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => git(wt, 'branch', '--show-current').trim()).toBe('feat/seconde-tache')
  expect(git(repo.path, 'stash', 'list')).toContain('canopy:feat/a')
})

test('stacked base shows in Code and PR', async () => {
  const wt = join(repo.path, '.worktrees', 'feat-a')
  git(repo.path, 'worktree', 'add', '-b', 'feat/a', wt, 'main')
  await writeFile(join(wt, 'a.txt'), 'a\n')
  git(wt, 'add', 'a.txt')
  git(wt, 'commit', '-m', 'work on a')
  await launch()
  await newTicket('Suite de a')
  await openLaunchPanel('REP-1')

  await page.getByRole('radio', { name: 'Worktree existant, nouvelle branche' }).check()
  await expect(page.getByLabel('Base auto')).toHaveValue('feat/a')
  await page.getByRole('button', { name: /^Lancer REP-1/ }).click()
  await expect(nav('Sessions')).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => git(wt, 'branch', '--show-current').trim()).toBe('feat/suite-de-a')

  await expect(page.getByTestId('pr-target')).toHaveText('Cible : feat/a')
  await nav('Code').click()
  const select = page.getByLabel('Branche de comparaison')
  await expect(select.locator('optgroup[label="Base de la branche"] option')).toHaveText(['feat/a'])
})

test('hand-edited ticket refreshes the list', async () => {
  await launch()
  await newTicket('Titre initial')
  await nav('Tickets').click()
  await expect(page.getByTestId('ticket-REP-1')).toContainText('Titre initial')

  const text = await readFile(ticketFile(), 'utf8')
  await writeFile(ticketFile(), text.replace('Titre initial', 'Titre modifié à la main'))
  await expect(page.getByTestId('ticket-REP-1')).toContainText('Titre modifié à la main', { timeout: 2_000 })
})
