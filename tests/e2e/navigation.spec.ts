import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../helpers/repo'

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page

const ALPHA = 'export function total(): number {\n  return 3\n}\n'
const BETA = 'import { total } from "./alpha"\nimport { helper } from "dep"\n\nexport const beta = total() + helper()\nconsole.log(beta)\n'

test.beforeEach(async () => {
  repo = await createRepo()
  await repo.commit('.gitignore', 'node_modules\n')
  await repo.commit('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' }, include: ['src'] }))
  await repo.commit('src/alpha.ts', ALPHA)
  await repo.commit('src/beta.ts', BETA)
  await repo.commit('src/tool.py', 'def compute():\n    return 1\n\nprint(compute())\n')
  await mkdir(join(repo.path, 'node_modules/dep'), { recursive: true })
  await writeFile(join(repo.path, 'node_modules/dep/index.d.ts'), 'export declare function helper(): number\n')
  await writeFile(join(repo.path, 'node_modules/dep/package.json'), '{"name":"dep","types":"index.d.ts"}')
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(1, { timeout: 20_000 })
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: 'Code', exact: true }).click()
})

test.afterEach(async () => {
  await app.close()
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const open = async (name: string): Promise<void> => {
  await page.getByLabel('Filtrer les fichiers').fill(name)
  await page.locator(`[data-testid="tree-file"][data-path="src/${name}"]`).click()
  await expect(page.getByTestId('code-editor').locator('.view-line').first()).toBeVisible()
}
/** Clicks the lowest occurrence of `text` in the editor: Monaco's spans do not follow words. */
const clickWord = async (text: string, modifier?: 'Meta'): Promise<void> => {
  await expect(page.getByTestId('code-editor')).toContainText(text)
  const at = await page.getByTestId('code-editor').evaluate((host, word) => {
    const walker = document.createTreeWalker(host.querySelector('.view-lines') as Node, NodeFilter.SHOW_TEXT)
    let best: { x: number; y: number } | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = (node.textContent ?? '').lastIndexOf(word)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + word.length)
      const box = range.getBoundingClientRect()
      if (!best || box.y >= best.y) best = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    return best
  }, text)
  if (!at) throw new Error(`${text} is not in the editor`)
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.click(at.x, at.y)
  if (modifier) await page.keyboard.up(modifier)
}
const SERVER_START = { timeout: 30_000 }

test('⌘click on a call opens the definition, at its line', async () => {
  await open('beta.ts')
  await clickWord('total', 'Meta')
  await expect(page.locator('.file-path')).toContainText('alpha.ts', SERVER_START)
  await expect(page.locator('.active-line-number')).toHaveText('1')
})

test('⇧F12 lists the calls, and a click goes to one', async () => {
  await open('alpha.ts')
  await clickWord('total')
  await page.keyboard.press('Shift+F12')
  const hits = page.getByTestId('results-panel').getByTestId('search-hit')
  await expect(hits).toHaveCount(2, SERVER_START)
  await hits.filter({ hasText: 'export const beta' }).click()
  await expect(page.locator('.file-path')).toContainText('beta.ts')
  await expect(page.locator('.active-line-number')).toHaveText('4')
})

test('a definition in node_modules opens read-only', async () => {
  await open('beta.ts')
  await clickWord('helper', 'Meta')
  await expect(page.locator('.file-path')).toContainText('node_modules/dep/index.d.ts', SERVER_START)
  await expect(page.getByTestId('read-only')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Modifier' })).toHaveCount(0)
})

test('a definition outside the worktree gives a message', async () => {
  await open('beta.ts')
  await clickWord('console', 'Meta')
  const results = page.getByTestId('results-panel').getByTestId('search-hit')
  const notice = page.getByTestId('nav-notice').filter({ hasText: 'Hors du worktree' })
  await expect(results.first().or(notice)).toBeVisible(SERVER_START)
  if (await results.count() > 0) await results.first().click()
  await expect(notice).toBeVisible()
  await expect(page.locator('.file-path')).toContainText('beta.ts')
})

test('in another language, the word is searched as text', async () => {
  await open('tool.py')
  await clickWord('compute', 'Meta')
  const hits = page.getByTestId('results-panel').getByTestId('search-hit')
  await expect(hits).toHaveCount(2)
  await expect(page.getByTestId('results-fallback')).toBeVisible()
})

test('⌘K finds a symbol and opens it', async () => {
  await page.keyboard.press('Meta+k')
  await page.getByRole('combobox', { name: 'Chercher' }).fill('total')
  const symbols = page.getByTestId('cmdbar-symbols').getByTestId('cmdbar-item')
  await expect(symbols.first()).toContainText('total', SERVER_START)
  await symbols.first().click()
  await expect(page.locator('.file-path')).toContainText('alpha.ts')
  await expect(page.locator('.active-line-number')).toHaveText('1')
})
