import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

// Runs against the fake GitHub gateway (`CANOPY_FAKE_GH`): never the real `gh`. Always a temp user-data-dir.
let repo: TestRepo
let userData: string
let app: ElectronApplication | undefined
let page: Page

const FIXTURE = resolve('tests/fixtures/gh/pr.json')
const BRANCH = 'feat/gtin-lookup'
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

const actions = (): string => join(userData, 'fake-gh-actions.jsonl')
const failFlag = (): string => join(userData, 'fake-gh-down')

async function launch(): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = {
    ...process.env,
    CANOPY_FAKE_QUERY: '1',
    CANOPY_FAKE_GH: FIXTURE,
    CANOPY_FAKE_GH_LOG: actions(),
    CANOPY_FAKE_GH_FAIL: failFlag()
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
  git(repo.path, 'worktree', 'add', '-b', BRANCH, join(repo.path, '.worktrees', 'feat-gtin-lookup'))
})

test.afterEach(async () => {
  if (app) await closeApp(app).catch(() => undefined)
  app = undefined
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const nav = (): Locator => page.getByRole('navigation', { name: 'Vues' })
const prTab = (): Locator => nav().getByRole('button', { name: /^PR/ })
const row = (text: string): Locator => page.getByTestId('worktree').filter({ hasText: text })
const header = (): Locator => page.getByTestId('pr-header')

async function loggedActions(): Promise<{ number: number; action: { type: string; draft?: boolean } }[]> {
  const text = await readFile(actions(), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { number: number; action: { type: string } })
}

async function openPr(): Promise<void> {
  await row(BRANCH).click()
  await expect(prTab()).toBeVisible({ timeout: 15_000 })
  await prTab().click()
  await expect(header()).toContainText('feat(products): look up passports by GTIN')
}

test('the PR tab shows for a branch with a PR and not for main', async () => {
  await launch()
  await row('main').first().click()
  await expect(nav().getByRole('button', { name: 'Code' })).toBeVisible()
  await expect(prTab()).toHaveCount(0)

  await openPr()
  // One unresolved thread in the fixture: the header badge counts it.
  await expect(prTab()).toContainText('1')
  await expect(header()).toContainText('#87')
  await expect(header().getByTestId('pr-state')).toHaveText('Ouverte')
  await expect(header()).toContainText('veut merger')
  const tabs = page.getByRole('tablist', { name: 'Sections de la PR' })
  await expect(tabs.getByRole('tab', { name: /Conversation/ })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab', { name: /Checks/ })).toBeVisible()

  // Back on main, no PR: the tab goes and the view falls back to Code.
  await row('main').first().click()
  await expect(prTab()).toHaveCount(0)
  await expect(nav().getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page')
})

test('draft toggle and close/reopen go through gh', async () => {
  await launch()
  await openPr()
  const state = header().getByTestId('pr-state')

  await header().getByRole('button', { name: 'Repasser en brouillon' }).click()
  await expect(state).toHaveText('Brouillon')
  await header().getByRole('button', { name: 'Prête pour review' }).click()
  await expect(state).toHaveText('Ouverte')

  await header().getByRole('button', { name: 'Fermer la PR' }).click()
  await expect(state).toHaveText('Fermée')
  await expect(header().getByRole('button', { name: 'Prête pour review' })).toHaveCount(0)
  await header().getByRole('button', { name: 'Rouvrir la PR' }).click()
  await expect(state).toHaveText('Ouverte')

  expect((await loggedActions()).map((l) => [l.number, l.action])).toEqual([
    [87, { type: 'draft', draft: true }],
    [87, { type: 'draft', draft: false }],
    [87, { type: 'close' }],
    [87, { type: 'reopen' }]
  ])
})

test('a failed action shows GitHub\'s message and keeps the PR', async () => {
  await launch()
  await openPr()
  await writeFile(failFlag(), '')
  await header().getByRole('button', { name: 'Fermer la PR' }).click()
  await expect(page.getByTestId('pr-error')).toContainText('hors ligne')
  await expect(header().getByTestId('pr-state')).toHaveText('Ouverte')
})

test('gh failing keeps the PR tab and shows the error', async () => {
  await launch()
  await openPr()
  await writeFile(failFlag(), '')
  // Leaving and entering the tab reads the PR again: find fails, the tab and the PR stay.
  await nav().getByRole('button', { name: 'Code' }).click()
  await prTab().click()
  await expect(page.getByTestId('pr-error')).toContainText('hors ligne')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(prTab()).toBeVisible()
  await expect(header().getByTestId('pr-state')).toHaveText('Ouverte')

  await rm(failFlag())
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('pr-error')).toHaveCount(0)
})

const thread = (): Locator => page.getByTestId('pr-thread').filter({ hasText: 'src/routes/products.ts' })

test('reply and resolve a thread', async () => {
  await launch()
  await openPr()
  await expect(thread()).toContainText('L19–20')
  await expect(thread()).toContainText('Should an unknown GTIN return 404')

  await thread().getByRole('button', { name: 'Répondre' }).click()
  await thread().getByRole('textbox', { name: 'Réponse' }).fill('Fixed in the last push.')
  await thread().getByRole('button', { name: 'Envoyer la réponse' }).click()
  await expect(thread()).toContainText('Fixed in the last push.')

  await thread().getByRole('button', { name: 'Résoudre la conversation' }).click()
  await expect(thread()).toContainText('Résolue')
  // Resolved: folded, the reopen button stays.
  await expect(thread()).not.toContainText('Fixed in the last push.')
  await expect(prTab()).not.toContainText('1')
  await thread().getByRole('button', { name: 'Rouvrir la conversation' }).click()
  await expect(thread()).not.toContainText('Résolue')

  expect((await loggedActions()).map((l) => l.action)).toEqual([
    { type: 'reply', commentId: 501, body: 'Fixed in the last push.' },
    { type: 'resolve', threadId: 'PRRT_kwDOgtin1', resolved: true },
    { type: 'resolve', threadId: 'PRRT_kwDOgtin1', resolved: false }
  ])
})

test('a Claude reply shows as Claude via Canopy', async () => {
  await launch()
  await openPr()
  const reply = thread().getByTestId('pr-comment').filter({ hasText: 'Good catch' })
  await expect(reply).toContainText('Claude · via Canopy')
  await expect(reply).not.toContainText('— Claude via Canopy')
  // A human comment keeps its login.
  await expect(page.getByTestId('pr-comment').filter({ hasText: 'document the new route' })).toContainText('theo-m')
})

test('comment, and approval disabled on one\'s own PR', async () => {
  await launch()
  await openPr()
  await page.getByRole('textbox', { name: 'Ajouter un commentaire' }).fill('Merci pour la revue !')
  await page.getByRole('button', { name: 'Commenter', exact: true }).click()
  await expect(page.getByTestId('pr-comment').filter({ hasText: 'Merci pour la revue !' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ajouter un commentaire' })).toHaveValue('')
  const approve = page.getByRole('button', { name: 'Approuver' })
  await expect(approve).toBeDisabled()
  await expect(approve).toHaveAttribute('title', "GitHub ne permet pas d'approuver sa propre PR")
  expect((await loggedActions()).map((l) => l.action)).toEqual([{ type: 'comment', body: 'Merci pour la revue !' }])
})

test('Faire corriger par Claude opens a new session with the thread', async () => {
  await launch()
  await row(BRANCH).click()
  // An empty session tab already open: Claude must not take it.
  await nav().getByRole('button', { name: 'Sessions' }).click()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await openPr()

  await thread().getByRole('button', { name: 'Faire corriger par Claude' }).click()
  await expect(nav().getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('tab')).toHaveCount(2)
  await expect(page.getByTestId('assistant-message').last()).toContainText('src/routes/products.ts:19–20')
  await expect(page.getByTestId('assistant-message').last()).toContainText('comments/501/replies')

  await prTab().click()
  await expect(thread().getByRole('button', { name: 'Claude a traité le retour' })).toBeVisible()
  // Nothing goes to GitHub: Claude answers the thread itself.
  expect(await loggedActions()).toEqual([])
})

test('Envoyer à Claude sends the comment to a new session and publishes nothing', async () => {
  await launch()
  await openPr()
  await page.getByRole('textbox', { name: 'Ajouter un commentaire' }).fill('Documente la route dans le README.')
  await page.getByRole('button', { name: 'Envoyer à Claude' }).click()
  await expect(nav().getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('assistant-message').last()).toContainText('Documente la route dans le README.')
  expect(await loggedActions()).toEqual([])
})
