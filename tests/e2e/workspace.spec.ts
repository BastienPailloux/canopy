import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Canopy Test',
  GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test',
  GIT_COMMITTER_EMAIL: 'test@canopy.local',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}

const git = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' }) }

/** A repo `name` under `root`, with one commit adding `<name>.txt`. */
async function nested(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  git(path, 'init', '-b', 'main')
  await writeFile(join(path, `${name}.txt`), `${name}\n`)
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'initial')
  return path
}

let parent: TestRepo
let root: string
let alpha: string
let beta: string
let userData: string
let app: ElectronApplication | undefined
let page: Page

async function launch(recents: string[]): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: recents, ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', SHELL: '/bin/bash' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
}

async function launchWorkspace(): Promise<void> {
  await launch([root])
  await expect(rows()).toHaveCount(6, { timeout: 20_000 })
}

test.beforeEach(async () => {
  parent = await createRepo({ dirName: 'espace-parent' })
  root = parent.path
  alpha = await nested(root, 'alpha')
  beta = await nested(root, 'beta')
  git(alpha, 'branch', 'develop')
  await writeFile(join(alpha, 'alpha.txt'), 'alpha\nmain only\n')
  git(alpha, 'commit', '-am', 'main only')
  await mkdir(join(root, '.worktrees', 'feat-x'), { recursive: true })
  git(alpha, 'worktree', 'add', '-b', 'feat-x', join(root, '.worktrees', 'feat-x', 'alpha'))
  git(beta, 'worktree', 'add', '-b', 'feat-x', join(root, '.worktrees', 'feat-x', 'beta'))
  git(beta, 'worktree', 'add', '-b', 'hot', join(root, 'ailleurs', 'beta-hot'))
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
})

test.afterEach(async () => {
  if (app) await closeApp(app).catch(() => undefined)
  app = undefined
  await parent.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const rows = (): Locator => page.getByTestId('worktree')
const row = (name: string): Locator => rows().filter({ has: page.getByTitle(name, { exact: true }) })
const composer = (): Locator => page.getByLabel(/^Message à Claude/)

async function send(text: string): Promise<void> {
  await composer().fill(text)
  await composer().press('Meta+Enter')
}

async function trust(path: string): Promise<void> {
  await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), path)
}

test('a parent folder lists its repos by section and opens on a real repo', async () => {
  await launchWorkspace()
  await expect(page.getByTestId('worktree-section-title')).toHaveText(['Principal', 'feat-x', 'Autres'])
  await expect(page.locator('[data-testid="worktree"] .name')).toHaveText(['alpha', 'beta', 'Espace', 'alpha · feat-x', 'beta · feat-x', 'beta · hot'])
  await expect(row('alpha')).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.repo-picker > button .name')).toHaveText('espace-parent')
})

test('every entry shows its numbers, whichever repo is active', async () => {
  await writeFile(join(root, '.worktrees', 'feat-x', 'beta', 'beta.txt'), 'beta\nchanged\n')
  await launchWorkspace()
  await expect(row('beta · feat-x')).toContainText('+1')
})

test('picking a repo shows its code, not the parent, and coming back restores the file', async () => {
  await launchWorkspace()
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: 'Code' }).click()
  const tree = page.getByRole('navigation', { name: 'Fichiers' })
  await page.getByRole('button', { name: 'Tout le repo' }).click()
  await tree.getByText('alpha.txt').click()
  await expect(page.locator('.code-top')).toContainText('main')

  await row('beta').click()
  await page.getByRole('button', { name: 'Tout le repo' }).click()
  await expect(tree.getByText('beta.txt')).toBeVisible()
  await expect(tree.getByText('alpha.txt')).toHaveCount(0)
  await expect(tree.getByText('README.md')).toHaveCount(0)

  // Its nested repos show as changes: the screen goes to "Modifiés" once they are read.
  await row('Espace').click()
  await expect(page.getByTestId('scope-changed')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Tout le repo' }).click()
  await expect(tree.getByText('README.md')).toBeVisible()

  await row('alpha').click()
  await expect(tree.locator('[data-testid="tree-file"][aria-current="true"]')).toHaveAttribute('data-path', 'alpha.txt')
})

test('a remembered base drives the comparison in every worktree of that repo', async () => {
  await launchWorkspace()
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: 'Code' }).click()
  const picker = page.getByLabel('Branche de comparaison')
  const remember = page.getByLabel('Mémoriser pour ce repo')
  await expect(picker).toHaveValue('main')
  await expect(page.getByTestId('code-totals')).toContainText('+0')
  await expect(remember).not.toBeChecked()

  await picker.selectOption('develop')
  await expect(page.getByTestId('code-totals')).toContainText('+1')
  await remember.check()
  await expect(remember).toBeChecked()
  await expect.poll(() => page.evaluate((r) => window.canopy.repoBase(r), alpha)).toBe('develop')

  await row('alpha · feat-x').click()
  await expect(picker).toHaveValue('develop')
  await expect(page.getByTestId('code-totals')).toContainText('+1')
  await expect(remember).toBeChecked()

  // Another repo keeps its own base.
  await row('beta').click()
  await expect(picker).toHaveValue('main')
  await expect(remember).not.toBeChecked()

  await row('alpha').click()
  await expect(remember).toBeChecked()
  await remember.uncheck()
  await expect.poll(() => page.evaluate((r) => window.canopy.repoBase(r), alpha)).toBeNull()

  const refused = await page.evaluate((r) => window.canopy.setRepoBase(r, undefined as unknown as null).then(() => 'accepted', () => 'refused'), alpha)
  expect(refused).toBe('refused')
})

test('session survives: it goes on in a repo while another is selected', async () => {
  await launchWorkspace()
  await trust(alpha)
  await send('lent')
  await expect(page.getByTestId('assistant-message')).toContainText('mot1')

  await row('beta').click()
  await expect(page.getByTestId('user-message')).toHaveCount(0)
  expect(await page.evaluate((p) => window.canopy.sessionActivity(p), alpha)).toBe('working')

  await row('alpha').click()
  await expect(page.getByTestId('user-message')).toHaveText(['lent'])
  await expect(page.getByTestId('assistant-message')).toContainText('mot40', { timeout: 15_000 })
  await expect(page.getByTestId('session-state')).toHaveText('prête')
})

test('the picker flags a repo of the workspace that waits for an answer, and the folder among recents', async () => {
  const other = await createRepo({ dirName: 'autre' })
  try {
    await launch([root, other.path])
    await expect(rows()).toHaveCount(6, { timeout: 20_000 })
    await row('beta').click()
    await trust(beta)
    await send('outil')
    await expect(page.getByTestId('permission-card')).toBeVisible()
    // The repo in front is not "another" one.
    await expect(page.getByTestId('repo-attention')).toHaveCount(0)

    await row('alpha').click()
    await expect(page.getByTestId('repo-attention')).toBeVisible()
    await expect(row('beta').getByTestId('worktree-status')).toHaveText('Attend ta réponse')

    expect(await page.evaluate((p) => window.canopy.repoNeedsAttention(p), root)).toBe(true)
    expect(await page.evaluate((p) => window.canopy.repoNeedsAttention(p, true), root)).toBe(false)

    await page.locator('.repo-picker > button').click()
    await page.getByRole('menuitem', { name: /autre/ }).click()
    await expect(page.locator('.repo-picker > button .name')).toHaveText('autre')
    await expect(rows()).toHaveCount(1)
    await expect(page.getByTestId('worktree-section-title')).toHaveCount(0)
    await expect(page.getByTestId('repo-attention')).toBeVisible()
    await page.locator('.repo-picker > button').click()
    await expect(page.getByRole('menuitem', { name: /espace-parent/ }).locator('.badge')).toBeVisible()
  } finally {
    await closeApp(app!).catch(() => undefined)
    app = undefined
    await other.cleanup()
  }
})

test('the parent repo waiting for an answer is flagged from a nested repo', async () => {
  await launchWorkspace()
  await row('Espace').click()
  await trust(root)
  await send('outil')
  await expect(page.getByTestId('permission-card')).toBeVisible()
  await row('alpha').click()
  await expect(page.getByTestId('repo-attention')).toBeVisible()
})

test('a window focus finds repos that came and went, without an error', async () => {
  await launchWorkspace()
  await row('beta').click()
  await nested(root, 'gamma')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(row('gamma')).toBeVisible()

  await rm(beta, { recursive: true, force: true })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(row('beta')).toHaveCount(0)
  await expect(row('alpha')).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.list-error')).toHaveCount(0)
})

test('the plus button creates in the active repo, the parent one included', async () => {
  await launchWorkspace()
  await row('beta').click()
  await page.getByRole('button', { name: 'Nouveau worktree' }).click()
  await page.getByLabel('Nom de la branche').fill('feat/b')
  await page.getByRole('button', { name: 'Créer', exact: true }).click()
  await expect(row('beta · feat/b')).toHaveAttribute('aria-current', 'true')
  await expect(row('beta · feat/b')).toHaveAttribute('data-path', new RegExp(`beta/.worktrees/feat-b$`))

  await row('Espace').click()
  await page.getByRole('button', { name: 'Nouveau worktree' }).click()
  await page.getByLabel('Nom de la branche').fill('feat/s')
  await page.getByRole('button', { name: 'Créer', exact: true }).click()
  await expect(row('espace-parent · feat/s')).toHaveAttribute('aria-current', 'true')
})

test('a worktree of a repo that is not the active one is removed from its own repo', async () => {
  await launchWorkspace()
  const target = row('beta · hot')
  await target.hover()
  await page.getByRole('button', { name: 'Supprimer beta · hot' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^Supprimer/ }).click()
  await expect(target).toHaveCount(0)
  await expect(row('alpha')).toHaveAttribute('aria-current', 'true')
})

test('a folder with one nested repo shows a plain list, and the folder in the picker', async () => {
  const holder = await realpath(await mkdtemp(join(tmpdir(), 'canopy-holder-')))
  try {
    const only = await nested(holder, 'seul')
    await launch([holder])
    await expect(rows()).toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByTestId('worktree-section-title')).toHaveCount(0)
    await expect(rows()).toHaveAttribute('data-path', only)
    await expect(page.getByTestId('active-worktree')).toHaveText('main')
  } finally {
    await closeApp(app!).catch(() => undefined)
    app = undefined
    await rm(holder, { recursive: true, force: true })
  }
})

test('the most recent folder holding no repo gives a clear message, not a list error', async () => {
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'canopy-empty-')))
  try {
    await launch([empty, root])
    await expect(page.getByRole('alert')).toContainText('Aucun repo git', { timeout: 20_000 })
    await expect(page.getByRole('alert')).toContainText(empty)
    await expect(page.getByRole('button', { name: 'Ouvrir un dépôt' })).toBeVisible()
    await expect(page.locator('.list-error')).toHaveCount(0)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('a recent folder that lost its repos keeps the open workspace and says why', async () => {
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'canopy-empty-')))
  try {
    await launch([root, empty])
    await expect(rows()).toHaveCount(6, { timeout: 20_000 })
    await page.locator('.repo-picker > button').click()
    await page.getByRole('menuitem', { name: /canopy-empty/ }).click()
    await expect(page.getByRole('alert')).toContainText('Aucun repo git')
    await expect(rows()).toHaveCount(6)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('a folder past the repo limit says the list is cut', async () => {
  const wide = await realpath(await mkdtemp(join(tmpdir(), 'canopy-wide-')))
  try {
    for (let i = 0; i < 201; i++) {
      const dir = join(wide, `r${i}`)
      await mkdir(dir)
      git(dir, 'init', '-b', 'main')
    }
    await launch([wide])
    await expect(page.getByTestId('workspace-truncated')).toContainText('200', { timeout: 30_000 })
  } finally {
    await closeApp(app!).catch(() => undefined)
    app = undefined
    await rm(wide, { recursive: true, force: true })
  }
})
