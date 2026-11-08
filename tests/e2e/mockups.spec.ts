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

const ID = 'AbCdEfGhIjKlMnOpQrStUv'
const LINK = `https://claude.ai/artifact/${ID}`

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

async function launch(): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', CANOPY_MOCKUP_VIEW_URL: 'about:blank' } as Record<string, string>
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

async function addByLink(title: string): Promise<void> {
  await nav('Maquettes').click()
  await page.getByRole('button', { name: '+ Ajouter un lien' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Ajouter une maquette' })
  await dialog.getByLabel('Lien claude.ai').fill(LINK)
  await dialog.getByLabel('Titre (facultatif)').fill(title)
  await dialog.getByRole('button', { name: 'Ajouter', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('add a mockup by link, link it to a ticket, edit and remove it', async () => {
  await launch()
  await addByLink('Page d’accueil')

  const card = page.getByTestId(`mockup-${ID}`)
  await expect(card).toContainText('Page d’accueil')
  await expect(card).toContainText('Sans ticket')
  const file = join(repo.path, '.mockups', 'mockups.json')
  await expect.poll(async () => readFile(file, 'utf8').catch(() => '')).toContain(ID)
  expect(git(repo.path, 'status', '--porcelain')).toBe('')

  // Create a ticket and link the mockup from the ticket editor (3b).
  await page.evaluate((r) => window.canopy.createTicket(r, {
    title: 'Refaire l’accueil', description: '', status: 'backlog', priority: 'none', labels: [], subtasks: []
  }), repo.path)
  await nav('Tickets').click()
  await page.getByTestId('ticket-REP-1').click()
  await page.getByRole('button', { name: '+ Lier ou générer une maquette' }).click()
  await page.getByRole('menuitem', { name: 'Page d’accueil' }).click()

  await nav('Maquettes').click()
  await expect(card).toContainText('REP-1')
  await expect(card).not.toContainText('Sans ticket')
  await page.getByRole('tab', { name: 'Sans ticket' }).click()
  await expect(card).toHaveCount(0)
  await page.getByRole('tab', { name: 'Toutes' }).click()
  await expect(card).toBeVisible()

  // Open the edit screen (4b): Propriétés shows the ticket; remove the mockup.
  await card.dblclick()
  await expect(page.getByRole('button', { name: '← Toutes les maquettes' })).toBeVisible()
  await page.getByRole('tab', { name: 'Propriétés' }).click()
  await expect(page.getByLabel('Ticket lié')).toHaveValue('REP-1')

  await page.getByRole('button', { name: 'Retirer de Canopy' }).click()
  await page.getByRole('group', { name: 'Confirmer le retrait' }).getByRole('button', { name: 'Retirer', exact: true }).click()
  await expect.poll(async () => readFile(file, 'utf8').catch(() => '')).not.toContain(ID)
  expect(git(repo.path, 'status', '--porcelain')).toBe('')
})
