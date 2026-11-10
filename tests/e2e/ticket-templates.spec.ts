import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const templateFile = (slug: string): string => join(repo.path, '.tickets', 'templates', `${slug}.md`)
const manager = (): Locator => page.getByRole('dialog', { name: 'Modèles de tickets' })
const settings = (): Locator => page.getByRole('dialog', { name: 'Réglages' })
const entry = (name: string): Locator => manager().getByRole('button', { name, exact: true })
const exists = (path: string): Promise<boolean> => readFile(path).then(() => true, () => false)

/** Opens « Modèles de tickets » from the settings, once the templates are listed. */
async function openManager(): Promise<void> {
  await launch()
  await page.getByRole('button', { name: 'Réglages' }).click()
  await settings().getByRole('button', { name: 'Modèles de tickets…' }).click()
  await expect(entry('Bug')).toBeVisible()
}

test('edits a template and uses it', async () => {
  await openManager()
  await entry('Bug').click()
  await manager().getByLabel('Description', { exact: true }).fill('### Reproduction\nTODO')
  await expect.poll(async () => readFile(templateFile('bug'), 'utf8').catch(() => '')).toContain('### Reproduction')

  // Escape in a field that answers it stays there; else it closes the top dialog only.
  await manager().getByRole('button', { name: 'Ajouter un label' }).click()
  await page.keyboard.press('Escape')
  await expect(manager().getByLabel('Nouveau label')).toHaveCount(0)
  await expect(manager()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(manager()).toHaveCount(0)
  await expect(settings()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings()).toHaveCount(0)

  await nav('Tickets').click()
  await page.getByRole('button', { name: '+ Nouveau ticket' }).click()
  await expect(description()).toHaveValue(/### Contexte/)
  await picker().selectOption({ label: 'Bug' })
  await expect(description()).toHaveValue(/### Reproduction/)
})

test('creates a template and makes it the default', async () => {
  await openManager()
  await manager().getByRole('button', { name: '+ Nouveau modèle' }).click()
  await expect(manager().getByLabel('Nom', { exact: true })).toHaveValue('Nouveau modèle')
  await manager().getByLabel('Nom', { exact: true }).fill('Spike')
  await manager().getByRole('button', { name: 'Définir par défaut' }).click()
  await expect.poll(() => exists(templateFile('spike'))).toBe(true)
  await expect.poll(async () => JSON.parse(await readFile(join(repo.path, '.tickets', 'config.json'), 'utf8').catch(() => '{}')).defaultTemplate).toBe('spike')
  await expect(manager().getByRole('button', { name: /^Spike/ })).toContainText('Par défaut')
  expect(await exists(templateFile('nouveau-modele'))).toBe(false)

  await manager().getByRole('button', { name: 'Fermer' }).click()
  await settings().getByRole('button', { name: 'Fermer' }).click()
  await nav('Tickets').click()
  await page.getByRole('button', { name: '+ Nouveau ticket' }).click()
  await expect(picker().locator('option:checked')).toHaveText('Spike')
})

test('deletes a template', async () => {
  await openManager()
  const seen = dialogs(() => true)
  await entry('Refacto').click()
  await manager().getByRole('button', { name: 'Supprimer', exact: true }).click()
  await expect.poll(() => exists(templateFile('refacto'))).toBe(false)
  expect(seen).toEqual(['Supprimer le modèle « Refacto » ?'])
  await expect(entry('Refacto')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await nav('Tickets').click()
  await page.getByRole('button', { name: '+ Nouveau ticket' }).click()
  await expect(description()).toHaveValue(/### Contexte/)
  await expect(picker().locator('option')).toHaveText(['Contexte', 'Fonctionnalité', 'Bug', 'Aucun'])
})

test('a failed delete keeps the template editable', async () => {
  await openManager()
  dialogs(() => true)
  await entry('Refacto').click()
  // A read-only folder: the delete fails.
  await chmod(join(repo.path, '.tickets', 'templates'), 0o555)
  try {
    await manager().getByRole('button', { name: 'Supprimer', exact: true }).click()
    await expect(manager().getByRole('alert')).toBeVisible()
  } finally {
    await chmod(join(repo.path, '.tickets', 'templates'), 0o755)
  }
  expect(await exists(templateFile('refacto'))).toBe(true)
  await manager().getByLabel('Description', { exact: true }).fill('### Après échec')
  await expect.poll(async () => readFile(templateFile('refacto'), 'utf8').catch(() => '')).toContain('### Après échec')
})

test('opens from the draft', async () => {
  await openDraft()
  await page.getByRole('button', { name: 'Gérer les modèles…' }).click()
  await expect(manager()).toBeVisible()
  await expect(entry('Bug')).toBeVisible()
})

test('deleting the template picked in the draft leaves its content', async () => {
  await openDraft()
  dialogs(() => true)
  await page.getByRole('button', { name: 'Gérer les modèles…' }).click()
  await manager().getByRole('button', { name: /^Contexte/ }).click()
  await manager().getByRole('button', { name: 'Supprimer', exact: true }).click()
  await expect.poll(() => exists(templateFile('contexte'))).toBe(false)
  await page.keyboard.press('Escape')
  await expect(manager()).toHaveCount(0)
  await expect(picker().locator('option')).toHaveText(['Fonctionnalité', 'Bug', 'Refacto', 'Aucun'])
  await expect(picker().locator('option:checked')).toHaveText('Fonctionnalité')
  await expect(description()).toHaveValue(/### Contexte/)
})

test('reorders templates', async () => {
  await openManager()
  await entry('Bug').click()
  await manager().getByRole('button', { name: 'Monter' }).click()
  const names = manager().getByRole('list', { name: 'Modèles' }).getByRole('button')
  await expect(names).toHaveText(['Contexte Par défaut', 'Bug', 'Fonctionnalité', 'Refacto'])
  await expect.poll(async () => readFile(templateFile('bug'), 'utf8')).toMatch(/order: 2/)
  await expect.poll(async () => readFile(templateFile('fonctionnalite'), 'utf8')).toMatch(/order: 3/)
})
