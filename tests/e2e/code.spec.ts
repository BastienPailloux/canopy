import { _electron as electron, expect, test, type ConsoleMessage, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../helpers/repo'

const SHOT = join(__dirname, '..', '..', '.superpowers', 'sdd', '2026-11-07-canopy-v1', 'task-9-code.png')

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page
let featPath: string
let violations: string[]

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Canopy Test',
  GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test',
  GIT_COMMITTER_EMAIL: 'test@canopy.local'
}
const git = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, env: GIT_ENV }) }

const ALPHA = 'export const a = 1\nexport const b = 2\nexport function total(): number {\n  return a + b\n}\n'
const ALPHA_V2 = 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport function total(): number {\n  return a + b + c\n}\n'

async function launch(worktrees = 2): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  violations = []
  const onConsole = (m: ConsoleMessage): void => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text())
  }
  page.on('console', onConsole)
  await expect(page.getByTestId('worktree')).toHaveCount(worktrees, { timeout: 20_000 })
  await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), repo.path)
}

test.beforeEach(async () => {
  repo = await createRepo()
  await repo.commit('src/alpha.ts', ALPHA)
  featPath = join(repo.path, '.worktrees', 'feat-a')
  git(repo.path, 'worktree', 'add', '-b', 'feat/a', featPath, 'main')
  // Claude's work: committed, so that `git diff` against the working tree is empty.
  await writeFile(join(featPath, 'src', 'alpha.ts'), ALPHA_V2)
  await writeFile(join(featPath, 'src', 'beta.ts'), 'export const beta = true\n')
  git(featPath, 'add', '-A')
  git(featPath, 'commit', '-qm', 'feat: c and beta')
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await mkdir(userData, { recursive: true })
})

test.afterEach(async () => {
  await app.close()
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const worktree = (name: string): Locator => page.getByTestId('worktree').filter({ hasText: name })
const treeFile = (path: string): Locator => page.locator(`[data-testid="tree-file"][data-path="${path}"]`)

async function openCode(): Promise<void> {
  await worktree('feat/a').click()
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: 'Code' }).click()
}

test('a committed change shows in "Modifiés" and in the Diff view, with no CSP violation', async () => {
  await launch()
  await openCode()

  await expect(page.getByTestId('scope-changed')).toHaveText('Modifiés · 2')
  await page.getByTestId('scope-changed').click()
  await expect(treeFile('src/alpha.ts')).toBeVisible()
  await expect(treeFile('src/beta.ts')).toBeVisible()
  await expect(treeFile('README.md')).toHaveCount(0)

  await treeFile('src/alpha.ts').click()
  await expect(page.getByTestId('file-badge')).toContainText('modifié')
  await expect(page.getByTestId('code-editor')).toContainText('export const c = 3')
  await expect(page.locator('.code-line-added')).toHaveCount(2)

  await page.getByRole('button', { name: /^Diff vs main/ }).click()
  const diff = page.getByTestId('diff-editor')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText('return a + b + c')
  await expect(diff.locator('.line-insert').first()).toBeVisible()
  await expect(page.getByTestId('code-totals')).toContainText('+')

  // The language service runs in a worker bundled with the app: give it a moment to fail if it would.
  await page.waitForTimeout(1500)
  expect(page.workers().length).toBeGreaterThan(0)
  await page.screenshot({ path: SHOT })
  expect(violations).toEqual([])
})

test('a whitespace-only change shows in the Diff view', async () => {
  await writeFile(join(featPath, 'indent.py'), 'def a():\n        return 1\n')
  git(featPath, 'add', '-A')
  git(featPath, 'commit', '-qm', 'feat: base for the indent')
  git(repo.path, 'branch', 'indent-base', 'feat/a')
  await writeFile(join(featPath, 'indent.py'), 'def a():\n    return 1\n')
  await launch()
  await openCode()
  await page.getByLabel('Branche de comparaison').selectOption('indent-base')
  await expect(page.getByTestId('scope-changed')).toHaveText('Modifiés · 1')
  await page.getByTestId('scope-changed').click()
  await treeFile('indent.py').click()
  await page.getByRole('button', { name: /^Diff vs indent-base/ }).click()
  const diff = page.getByTestId('diff-editor')
  await expect(diff).toContainText('return 1')
  await expect(diff.locator('.line-insert, .char-insert').first()).toBeVisible({ timeout: 5_000 })
})

test('a normal diff shows no incomplete warning', async () => {
  await launch()
  await openCode()
  await treeFile('src/alpha.ts').click()
  await page.getByRole('button', { name: /^Diff vs main/ }).click()
  await expect(page.getByTestId('diff-editor').locator('.line-insert').first()).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('diff-abandoned')).toHaveCount(0)
})

test('a diff Monaco gives up on says so instead of passing for complete', async () => {
  test.setTimeout(120_000)
  // Every line differs and both sides are huge: no line diff finishes within the cap.
  const lines = (seed: string): string => Array.from({ length: 280_000 }, (_, i) => `${seed}${(i * 2654435761 % 4294967296).toString(36)}`).join('\n')
  await writeFile(join(featPath, 'huge.txt'), lines('a'))
  git(featPath, 'add', '-A')
  git(featPath, 'commit', '-qm', 'feat: huge file')
  git(repo.path, 'branch', 'huge-base', 'feat/a')
  await writeFile(join(featPath, 'huge.txt'), lines('b'))
  await launch()
  await openCode()
  await page.getByLabel('Branche de comparaison').selectOption('huge-base')
  await expect(page.getByTestId('scope-changed')).toHaveText('Modifiés · 1')
  await page.getByTestId('scope-changed').click()
  await treeFile('huge.txt').click()
  await page.getByRole('button', { name: /^Diff vs huge-base/ }).click()
  await expect(page.getByTestId('diff-computing')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('diff-abandoned')).toContainText('incomplet', { timeout: 60_000 })
  await expect(page.getByTestId('diff-computing')).toHaveCount(0)
})

test('with no base branch, the comparison picker stays usable and a pick loads the diff', async () => {
  git(repo.path, 'branch', '-m', 'main', 'trunk')
  await launch()
  await openCode()
  const picker = page.getByLabel('Branche de comparaison')
  await expect(picker).toBeEnabled({ timeout: 10_000 })
  await picker.selectOption('trunk')
  await expect(page.getByTestId('scope-changed')).toHaveText('Modifiés · 2')
})

test('an external write refreshes the changed list and the sidebar numbers', async () => {
  await launch()
  await openCode()
  await expect(page.getByTestId('scope-changed')).toHaveText('Modifiés · 2')
  await expect(worktree('feat/a')).toContainText('+3')

  await writeFile(join(featPath, 'gamma.ts'), 'one\ntwo\n')
  await expect(page.getByTestId('scope-changed')).toHaveText('Modifiés · 3', { timeout: 10_000 })
  // The sidebar is refreshed by the watcher well before its 10 s poll.
  await expect(worktree('feat/a')).toContainText('+5', { timeout: 8_000 })
})

test('a binary file shows a message, and the filter finds files', async () => {
  await writeFile(join(featPath, 'logo.bin'), Buffer.from([0, 1, 2, 0]))
  await launch()
  await openCode()
  await page.getByTestId('scope-changed').click()
  await treeFile('logo.bin').click()
  await expect(page.getByRole('status')).toContainText('binaire')

  await page.getByRole('button', { name: 'Tout le repo' }).click()
  await page.getByLabel('Filtrer les fichiers').fill('alp')
  await expect(treeFile('src/alpha.ts')).toBeVisible()
  await expect(treeFile('README.md')).toHaveCount(0)
})

test('saving refuses to overwrite what Claude changed meanwhile', async () => {
  await launch()
  await openCode()
  await treeFile('src/beta.ts').click()
  await page.getByRole('button', { name: 'Modifier' }).click()
  await page.getByTestId('code-editor').click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('// mine\n')
  await expect(page.getByText('non enregistré')).toBeVisible()

  await writeFile(join(featPath, 'src', 'beta.ts'), 'export const beta = false // claude\n')
  await page.keyboard.press('Meta+s')
  await expect(page.getByTestId('disk-changed')).toBeVisible()
  expect(await readFile(join(featPath, 'src', 'beta.ts'), 'utf8')).toBe('export const beta = false // claude\n')

  await page.getByRole('button', { name: 'Écraser quand même' }).click()
  await expect(page.getByTestId('disk-changed')).toHaveCount(0)
  expect(await readFile(join(featPath, 'src', 'beta.ts'), 'utf8')).toContain('// mine')
})

test('a file that is not UTF-8 opens read-only, with the reason', async () => {
  await writeFile(join(featPath, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await launch()
  await openCode()
  await page.getByTestId('scope-changed').click()
  await treeFile('latin.txt').click()
  await expect(page.getByTestId('not-utf8')).toContainText('UTF-8')
  await expect(page.getByTestId('read-only')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Modifier' })).toHaveCount(0)
})

test('a plain save writes the file', async () => {
  await launch()
  await openCode()
  await treeFile('src/beta.ts').click()
  await page.getByRole('button', { name: 'Modifier' }).click()
  await page.getByTestId('code-editor').click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('// saved\n')
  await page.keyboard.press('Meta+s')
  await expect(page.getByText('non enregistré')).toHaveCount(0)
  expect(await readFile(join(featPath, 'src', 'beta.ts'), 'utf8')).toContain('// saved')
})

test('"Voir le diff" on a tool card opens the Code view on that file in Diff mode', async () => {
  await launch()
  await worktree('feat/a').click()
  await page.getByLabel(/^Message à Claude/).fill('editer')
  await page.getByLabel(/^Message à Claude/).press('Meta+Enter')
  await page.getByTestId('permission-card').getByRole('button', { name: 'Autoriser' }).click()
  await page.getByTestId('tool-card').getByRole('button', { name: 'Voir le diff' }).click()
  await expect(page.getByTestId('diff-editor')).toBeVisible()
  await expect(page.getByTestId('file-badge')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Diff vs main/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.file-path')).toContainText('src/alpha.ts')
})

test('"Demander à Claude" sends the path and the selection to the worktree session', async () => {
  await launch()
  await openCode()
  await treeFile('src/beta.ts').click()
  await expect(page.getByTestId('code-editor')).toContainText('export const beta')
  await page.getByTestId('code-editor').click()
  await page.keyboard.press('Meta+a')
  await page.getByRole('button', { name: 'Demander à Claude' }).click()
  await page.getByLabel('Question pour Claude').fill('Pourquoi ?')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByTestId('assistant-message').first()).toContainText('src/beta.ts', { timeout: 15_000 })
  await expect(page.getByTestId('assistant-message').first()).toContainText('export const beta = true')
})

const navButton = (name: string): Locator => page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name })

test('a consumed "Voir le diff" request is not applied again, and another worktree selects its first change', async () => {
  const other = join(repo.path, '.worktrees', 'feat-b')
  git(repo.path, 'worktree', 'add', '-b', 'feat/b', other, 'main')
  await writeFile(join(other, 'zeta.ts'), 'export const z = 1\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', 'feat: zeta')
  await launch(3)
  await worktree('feat/a').click()
  await page.getByLabel(/^Message à Claude/).fill('editer')
  await page.getByLabel(/^Message à Claude/).press('Meta+Enter')
  await page.getByTestId('permission-card').getByRole('button', { name: 'Autoriser' }).click()
  await page.getByTestId('tool-card').getByRole('button', { name: 'Voir le diff' }).click()
  await expect(page.locator('.file-path')).toContainText('src/alpha.ts')

  // The user's own choice: another file, in Code mode.
  await treeFile('src/beta.ts').click()
  await page.getByRole('group', { name: "Mode d'affichage" }).getByRole('button', { name: 'Code' }).click()
  await navButton('Sessions').click()
  await navButton('Code').click()
  await expect(page.locator('.file-path')).toContainText('src/beta.ts')
  await expect(page.getByTestId('code-editor')).toBeVisible()

  await worktree('feat/b').click()
  await expect(page.locator('.file-path')).toContainText('zeta.ts')
})

test('unsaved typing survives a visit to Sessions, a branch change and a worktree switch', async () => {
  git(repo.path, 'branch', 'other', 'main')
  await launch()
  await openCode()
  await treeFile('src/beta.ts').click()
  await page.getByRole('button', { name: 'Modifier' }).click()
  await page.getByTestId('code-editor').click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('// keep me\n')
  await expect(page.getByText('non enregistré')).toBeVisible()

  await page.getByLabel('Branche de comparaison').selectOption('other')
  await expect(page.getByText('non enregistré')).toBeVisible()
  await expect(page.getByTestId('code-editor')).toContainText('// keep me')

  await navButton('Sessions').click()
  await navButton('Code').click()
  await expect(page.getByText('non enregistré')).toBeVisible()
  await expect(page.getByTestId('code-editor')).toContainText('// keep me')

  await worktree('main').click()
  await worktree('feat/a').click()
  await expect(page.getByTestId('code-editor')).toContainText('// keep me')
  expect(await readFile(join(featPath, 'src', 'beta.ts'), 'utf8')).not.toContain('keep me')
})

test('a comparison branch that disappears falls back to the default with a message', async () => {
  git(repo.path, 'branch', 'tmp', 'main')
  await launch()
  await openCode()
  await page.getByLabel('Branche de comparaison').selectOption('tmp')
  await expect(page.getByLabel('Branche de comparaison')).toHaveValue('tmp')
  git(repo.path, 'branch', '-D', 'tmp')
  await writeFile(join(featPath, 'poke.ts'), 'x\n')
  await expect(page.getByTestId('base-notice')).toContainText('tmp')
  await expect(page.getByLabel('Branche de comparaison')).toHaveValue('main')
  await expect(page.getByLabel('Branche de comparaison')).toBeEnabled()
})
