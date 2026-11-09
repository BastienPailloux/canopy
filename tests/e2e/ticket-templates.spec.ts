import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page

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
const description = (): Locator => page.getByPlaceholder('Décris le ticket en Markdown…')
const picker = (): Locator => page.getByLabel('Modèle', { exact: true })
const props = (): Locator => page.getByRole('complementary', { name: 'Propriétés' })

/** Opens the new-ticket draft, once the default template is in. */
async function openDraft(): Promise<void> {
  await launch()
  await nav('Tickets').click()
  await page.getByRole('button', { name: '+ Nouveau ticket' }).click()
  await expect(description()).toHaveValue(/### Contexte/)
}

/** Messages of the dialogs shown; each is answered `accept`. */
function dialogs(accept: () => boolean): string[] {
  const seen: string[] = []
  page.on('dialog', (d) => {
    seen.push(d.message())
    void (accept() ? d.accept() : d.dismiss())
  })
  return seen
}

test('new ticket starts from the default template', async () => {
  await openDraft()
  await expect(picker().locator('option:checked')).toHaveText('Contexte')
  await expect(picker().locator('option')).toHaveText(['Contexte', 'Fonctionnalité', 'Bug', 'Refacto', 'Aucun'])
})

test('switching template without edits replaces silently', async () => {
  await openDraft()
  const seen = dialogs(() => true)
  await picker().selectOption({ label: 'Bug' })
  await expect(description()).toHaveValue(/### Étapes pour reproduire/)
  await expect(props().locator('.chip')).toHaveText(['bug×'])
  await expect(props().getByLabel('Priorité')).toHaveValue('high')
  await expect(page.getByRole('checkbox', { name: 'Écrire un test qui reproduit le bug' })).toBeVisible()
  expect(seen).toEqual([])
})

test('switching template after an edit asks first', async () => {
  await openDraft()
  let accept = false
  const seen = dialogs(() => accept)
  await description().fill('Mon texte à moi')
  await picker().selectOption({ label: 'Refacto' })
  await expect.poll(() => seen.length).toBe(1)
  expect(seen[0]).toBe('Remplacer le contenu par le modèle « Refacto » ? Ce que tu as écrit sera perdu.')
  await expect(description()).toHaveValue('Mon texte à moi')
  await expect(picker().locator('option:checked')).toHaveText('Contexte')

  accept = true
  await picker().selectOption({ label: 'Refacto' })
  await expect(description()).toHaveValue(/### Problème actuel/)
  await expect(picker().locator('option:checked')).toHaveText('Refacto')
  expect(seen).toHaveLength(2)
})

test('selector disappears once the ticket has a title', async () => {
  await openDraft()
  await page.getByLabel('Titre', { exact: true }).fill('Ajouter la recherche')
  await expect(page.getByRole('navigation', { name: "Fil d'Ariane" })).toContainText('REP-1')
  await expect.poll(async () => readFile(ticketFile(), 'utf8').catch(() => '')).toContain('### Contexte')
  await expect(picker()).toHaveCount(0)
})

test('Aucun gives an empty ticket', async () => {
  await openDraft()
  await picker().selectOption({ label: 'Aucun' })
  await expect(description()).toHaveValue('')
})
