import { _electron as electron, expect, test, type ConsoleMessage, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp } from '../helpers/closeApp'
import { createRepo, type TestRepo } from '../helpers/repo'

const SHOT = join(__dirname, '..', '..', '.superpowers', 'sdd', '2026-11-07-canopy-v1', 'task-12-terminal.png')

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

async function launch(): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  // A fixed shell: the test must not depend on the rc files of whoever runs it.
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1', SHELL: '/bin/bash' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  violations = []
  page.on('console', (m: ConsoleMessage) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text())
  })
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`))
  await expect(page.getByTestId('worktree')).toHaveCount(2, { timeout: 20_000 })
}

test.beforeEach(async () => {
  repo = await createRepo()
  await repo.commit('src/alpha.ts', 'export const a = 1\n')
  featPath = join(repo.path, '.worktrees', 'feat-a')
  execFileSync('git', ['worktree', 'add', '-b', 'feat/a', featPath, 'main'], { cwd: repo.path, env: GIT_ENV })
  userData = await mkdtemp(join(tmpdir(), 'canopy-e2e-'))
  await mkdir(userData, { recursive: true })
})

test.afterEach(async () => {
  await closeApp(app).catch(() => undefined)
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const worktree = (name: string): Locator => page.getByTestId('worktree').filter({ hasText: name })
const panel = (): Locator => page.getByRole('region', { name: 'Terminal du worktree' })
const screen = (): Locator => panel().locator('.xterm-rows')
const tab = (name: string): Locator => panel().getByRole('tab', { name })

test('a shell works under the CSP, survives view and worktree changes, and ⌃` toggles the panel', async () => {
  await launch()
  await worktree('feat/a').click()
  await expect(panel()).toHaveCount(0)

  await page.keyboard.press('Control+`')
  await expect(panel()).toBeVisible()
  await expect(screen()).toBeVisible({ timeout: 15_000 })
  await page.locator('.xterm-helper-textarea').click()
  await page.keyboard.type('echo sum=$((20+22))')
  await page.keyboard.press('Enter')
  await expect(screen()).toContainText('sum=42', { timeout: 15_000 })

  // The shell lives in the main process: other views and worktrees do not stop it.
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: 'Code' }).click()
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name: 'Sessions' }).click()
  await worktree('main').click()
  await worktree('feat/a').click()
  await expect(panel()).toBeVisible()
  await expect(panel().getByRole('tab')).toHaveCount(1)
  await expect(screen()).toContainText('sum=42')
  expect(await page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.length), featPath)).toBe(1)

  await page.screenshot({ path: SHOT })
  await page.keyboard.press('Control+`')
  await expect(panel()).toHaveCount(0)
  expect(violations).toEqual([])
})

test('a terminal showing up does not take the focus from the composer', async () => {
  await launch()
  await worktree('feat/a').click()
  await page.keyboard.press('Control+`')
  await expect(screen()).toBeVisible({ timeout: 15_000 })
  await panel().getByRole('button', { name: 'Nouveau terminal' }).click()
  await expect(panel().getByRole('tab')).toHaveCount(2)
  const composer = page.getByLabel(/^Message à Claude/)
  await composer.focus()
  // Not a mouse click, which would take the focus itself: what a restarted service does.
  await panel().getByRole('tab').first().evaluate((el) => (el as HTMLElement).click())
  await expect(panel().getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await page.waitForTimeout(200)
  await expect(composer).toBeFocused()
})

test('a service gets its portEnv, and its port shows on the worktree row', async () => {
  await mkdir(join(featPath, '.canopy'), { recursive: true })
  await writeFile(join(featPath, '.canopy', 'config.json'), JSON.stringify({ services: [{ name: 'web', command: 'echo got-$VITE_PORT; sleep 60', portEnv: 'VITE_PORT' }] }))
  await launch()
  await worktree('feat/a').click()
  await page.evaluate(async (p) => {
    await window.canopy.trustRepo(p, (await window.canopy.repoTrust(p)).configHash)
    await window.canopy.runServices(p)
  }, featPath)
  await expect(worktree('feat/a').getByTestId('worktree-port')).toHaveText(':4100', { timeout: 10_000 })
  await expect.poll(async () => page.evaluate(async (p) => {
    const [t] = await window.canopy.listTerminals(p)
    return (await window.canopy.terminalSnapshot(t.id)).data
  }, featPath), { timeout: 60_000 }).toContain('got-4100')
})

test('« Tester la PR » asks to trust the commands, runs setup then the services on reserved ports, and sends logs to Claude', async () => {
  await mkdir(join(featPath, '.canopy'))
  await writeFile(join(featPath, '.canopy', 'config.json'), JSON.stringify({
    setup: ['echo setup-done'],
    services: [{ name: 'web', command: 'echo web-on-$PORT; sleep 60' }]
  }))
  await launch()
  await worktree('feat/a').click()
  await page.getByRole('button', { name: /^Tester la PR/ }).click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByTestId('trust-setup')).toContainText('echo setup-done')
  await expect(dialog.getByTestId('trust-services')).toContainText('web: echo web-on-$PORT; sleep 60')
  await dialog.getByRole('button', { name: 'Faire confiance' }).click()

  const link = panel().getByTestId('terminal-link')
  await expect(link).toHaveText(/localhost:41\d\d/, { timeout: 20_000 })
  const port = (await link.innerText()).match(/localhost:(\d+)/)?.[1] ?? ''
  await tab('web').click()
  await expect(screen()).toContainText(`web-on-${port}`, { timeout: 15_000 })
  await tab('setup').click()
  await expect(screen()).toContainText('setup-done')
  await expect(tab('setup')).toContainText('terminé')

  await tab('web').click()
  await panel().getByRole('button', { name: 'Envoyer les logs à Claude' }).click()
  await expect(page.getByTestId('user-message').last()).toContainText(`web-on-${port}`)
  await expect(page.getByTestId('user-message').last()).toContainText('```')

  // Restart keeps the reserved port.
  const serviceId = (): Promise<string | undefined> => page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.find((t) => t.label === 'web')?.id), featPath)
  const before = await serviceId()
  await panel().getByRole('button', { name: 'Redémarrer' }).click()
  await expect.poll(serviceId).not.toBe(before)
  await expect(panel().getByTestId('terminal-link')).toHaveText(new RegExp(`localhost:${port}`))
  await expect(panel().getByRole('tab', { name: /web/ })).toHaveCount(1)

  await expect(tab('web')).toContainText('en cours')
  await panel().getByRole('button', { name: 'Arrêter' }).click()
  await expect(tab('web')).toContainText(/terminé|code/, { timeout: 10_000 })
  expect(violations).toEqual([])
})

test('commands set in Réglages replace .canopy/config.json for « Tester la PR », with no trust prompt', async () => {
  await mkdir(join(featPath, '.canopy'))
  await writeFile(join(featPath, '.canopy', 'config.json'), JSON.stringify({ services: [{ name: 'file', command: 'echo from-file; sleep 60' }] }))
  await launch()
  await worktree('feat/a').click()

  await page.getByRole('button', { name: 'Réglages' }).click()
  const settings = page.getByTestId('launch-settings')
  await expect(settings).toContainText('utilise .canopy/config.json')
  await settings.getByTestId('launch-setup').fill('echo settings-setup')
  await settings.getByLabel('Nom du service').fill('api')
  await settings.getByLabel('Commande du service').fill('echo api-on-$API_PORT; sleep 60')
  await settings.getByLabel('Variable du port').fill('API_PORT')
  await settings.getByRole('button', { name: 'Enregistrer le lancement' }).click()
  await expect(page.getByText('Lancement enregistré.')).toBeVisible()
  await expect(settings).toContainText('remplace .canopy/config.json')
  await page.getByRole('dialog', { name: 'Réglages' }).getByRole('button', { name: 'Fermer' }).click()

  await page.getByRole('button', { name: /^Tester la PR/ }).click()
  await expect(tab('api')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(panel().getByRole('tab', { name: /file/ })).toHaveCount(0)
  const port = ((await panel().getByTestId('terminal-link').innerText()).match(/localhost:(\d+)/)?.[1]) ?? ''
  await tab('api').click()
  await expect(screen()).toContainText(`api-on-${port}`, { timeout: 15_000 })
  await tab('setup').click()
  await expect(screen()).toContainText('settings-setup')

  // A setting that breaks the rules is refused with the reason.
  await page.getByRole('button', { name: 'Réglages' }).click()
  await settings.getByLabel('Variable du port').fill('PATH')
  await settings.getByRole('button', { name: 'Enregistrer le lancement' }).click()
  await expect(page.getByTestId('launch-error')).toContainText('Réglage invalide')
  await settings.getByRole('button', { name: 'Revenir au fichier' }).click()
  await expect(settings).toContainText('utilise .canopy/config.json')
  expect(violations).toEqual([])
})

test('the main process refuses scripts for a config that was not approved', async () => {
  await mkdir(join(featPath, '.canopy'))
  await writeFile(join(featPath, '.canopy', 'config.json'), JSON.stringify({ setup: ['touch pwned'], services: [] }))
  await launch()
  const refused = await page.evaluate((p) => window.canopy.runSetup(p).then(() => 'ran', (e: Error) => e.message), featPath)
  expect(refused).toContain('REPO_NOT_TRUSTED')
  expect(await page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.length), featPath)).toBe(0)
  // A plain shell needs no trust.
  expect(await page.evaluate((p) => window.canopy.createTerminal(p).then((t) => t.kind), featPath)).toBe('shell')
})

test('removing a worktree that has a running terminal reports the exit and nothing crashes', async () => {
  await launch()
  const id = await page.evaluate((p) => window.canopy.createTerminal(p).then((t) => t.id), featPath)
  await page.evaluate(([r, p]) => window.canopy.removeWorktree(r, p, true), [repo.path, featPath])
  await expect.poll(() => page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.find((t) => t.running)), featPath)).toBeUndefined()
  expect(id).toMatch(/^term-/)
  expect(await page.evaluate((p) => window.canopy.createTerminal(p).then(() => 'ok', (e: Error) => e.message), featPath)).toContain('introuvable')
})

test('quitting with a terminal running asks once with the count; cancel keeps it, confirm stops everything', async () => {
  await launch()
  await page.evaluate((p) => window.canopy.createTerminal(p), featPath)
  // The native dialog is replaced by a recorder whose answer the test picks.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[]; answer: number }
    g.asked = []
    g.answer = 1
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.at(-1) as { detail: string }
      g.asked.push(o.detail)
      return { response: g.answer, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox
  })

  await app.evaluate(({ app: a }) => { a.quit() })
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.length)).toBe(1)
  expect(await app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked[0])).toBe('Quitter arrêtera : 1 terminal actif.')
  // Cancelled: the window and the terminal are still there.
  expect(await page.evaluate((p) => window.canopy.listTerminals(p).then((l) => l.filter((t) => t.running).length), featPath)).toBe(1)

  await app.evaluate(() => { (globalThis as unknown as { answer: number }).answer = 0 })
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
  await app.evaluate(({ app: a }) => { a.quit() }).catch(() => undefined)
  await exited
})
