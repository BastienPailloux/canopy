import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'

let userData: string
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  // The shell may export ELECTRON_RUN_AS_NODE=1, which would make Electron behave as plain Node.
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
})

test.afterEach(async () => {
  await closeApp(app)
  await rm(userData, { recursive: true, force: true })
})

/** Plays the main process telling the window about the update. */
const emit = (state: unknown): Promise<void> =>
  app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].webContents.send('canopy:event', 'update:state', s)
  }, state)

test('announces a ready update, then the countdown, with no way to close it', async () => {
  const banner = page.getByTestId('update-banner')
  await expect(page.locator('.header')).toBeVisible({ timeout: 20_000 }) // the listener is up once the app has rendered
  await expect(banner).toHaveCount(0)

  await emit({ phase: 'ready', version: '9.9.9', deadline: Date.now() + 3_600_000 })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Nouvelle version 9.9.9 prête. Redémarrage obligatoire')
  await expect(banner.getByRole('button', { name: 'Redémarrer', exact: true })).toBeEnabled()

  await emit({ phase: 'warning', version: '9.9.9', restartAt: Date.now() + 600_000 })
  await expect(banner).toContainText('Canopy redémarre dans')
  await expect(banner.getByRole('button', { name: 'Redémarrer maintenant' })).toBeVisible()
  await expect(banner.getByRole('button')).toHaveCount(1)

  await emit({ phase: 'none' })
  await expect(banner).toHaveCount(0)
})
