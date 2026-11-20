import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

let repo: TestRepo
let userData: string
let app: ElectronApplication | undefined
let page: Page

/** One launch per fake mode: main reads `CANOPY_FAKE_CAPTURE` once. */
async function launch(capture: string): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', CANOPY_FAKE_CAPTURE: capture } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(1, { timeout: 20_000 })
  await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), repo.path)
  await expect(composer()).toBeVisible()
}

test.beforeEach(async () => {
  repo = await createRepo()
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
})

test.afterEach(async () => {
  if (app) await closeApp(app)
  app = undefined
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const composer = (): Locator => page.getByLabel(/^Message à Claude/)

async function capture(item: "Capture d'écran" | 'Enregistrer'): Promise<void> {
  await page.getByRole('button', { name: "Capturer l'écran" }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

async function send(text: string): Promise<void> {
  await composer().fill(text)
  await composer().press('Meta+Enter')
}

test('a screenshot from the camera menu is attached and sent', async () => {
  await launch('1')
  await capture("Capture d'écran")
  await expect(page.getByRole('button', { name: "Retirer l'image 1" })).toBeVisible()
  await send('regarde')
  await expect(page.getByTestId('user-message').getByRole('img', { name: 'Image jointe' })).toBeVisible()
})

test('a recording is attached as one chip and sent with its frames', async () => {
  await launch('1')
  await capture('Enregistrer')
  await expect(page.getByTestId('draft-recording')).toHaveCount(1)
  await expect(page.getByTestId('draft-recording')).toContainText('1 clic')
  await send('voilà le bug')
  await expect(page.getByTestId('user-recording').getByRole('img')).toHaveCount(2)
  await expect(page.getByTestId('user-message')).not.toContainText('screen-recording')
  await expect(page.getByTestId('draft-recording')).toHaveCount(0)
})

test('a cancelled selection attaches nothing', async () => {
  await launch('cancel')
  // What main sent back, seen from the page: proof that each cancel arrived before the next capture starts.
  await page.evaluate(() => {
    const w = window as unknown as { __captures: string[] }
    w.__captures = []
    window.canopy.on('capture:done', (r) => { w.__captures.push((r as { kind: string }).kind) })
  })
  const captures = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __captures: string[] }).__captures)
  await capture("Capture d'écran")
  await expect.poll(captures).toEqual(['cancelled'])
  await capture('Enregistrer')
  await expect.poll(captures).toEqual(['cancelled', 'cancelled'])
  await expect(page.getByTestId('draft-recording')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Retirer/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Envoyer/ })).toBeDisabled()
})

test('missing screen permission opens the explanation', async () => {
  await launch('denied')
  await capture("Capture d'écran")
  const dialog = page.getByRole('alertdialog', { name: "Autoriser l'enregistrement de l'écran" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('relance Canopy')
  await dialog.getByRole('button', { name: 'Annuler' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Retirer/ })).toHaveCount(0)
})

test('a recording without clicks says so on its chip, without a dialog: no permission would help', async () => {
  await launch('noclicks')
  await capture('Enregistrer')
  await expect(page.getByTestId('draft-recording')).toContainText('clics non enregistrés')
  await expect(page.getByRole('alertdialog', { name: 'Clics non enregistrés' })).toHaveCount(0)
})

test('the camera menu works from the keyboard', async () => {
  await launch('1')
  const button = page.getByRole('button', { name: "Capturer l'écran" })
  await expect(button).toHaveAttribute('aria-haspopup', 'menu')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const shot = page.getByRole('menuitem', { name: "Capture d'écran" })
  const record = page.getByRole('menuitem', { name: 'Enregistrer' })
  await expect(shot).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(record).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(shot).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(record).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
})

test('the recording shortcut starts a recording', async () => {
  await launch('1')
  // Playwright's keys reach the page, not the macOS menu: the shortcut is fired as the menu would, by clicking its entry.
  await app!.evaluate(({ Menu }) => { Menu.getApplicationMenu()?.getMenuItemById('shortcut:capture-recording')?.click() })
  await expect(page.getByTestId('draft-recording')).toContainText('1 clic')
})
