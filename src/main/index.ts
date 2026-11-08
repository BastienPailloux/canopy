import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as pty from 'node-pty'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { claudeAuthRunner, selectAccountRunner } from './account'
import { AppStore } from './appStore'
import { TicketStore } from './tickets/store'
import { localBranches } from './tickets/ticketIpc'
import { openExternalUrl } from './externalLinks'
import { isConfigTrusted } from './repoTrust'
import { LinearClient, linearOpener } from './linear/client'
import { LinearEdits } from './linear/edits'
import { LinkedIssues, registerLinearIpc, startLinear } from './linear/linearIpc'
import { selectLinearOpener } from './linear/replay'
import { LinearSync } from './linear/sync'
import { MockupStore } from './mockups/store'
import { LspPool } from './code/lsp'
import { stopAllWatchers } from './code/watchers'
import { createCrashReload } from './crashReload'
import { currentEnv, startEnv } from './env'
import { hiddenWindow } from './hiddenWindow'
import { installCli } from './installCli'
import { broadcast, registerIpc, registerUpdateIpc } from './ipc'
import { menuTemplate } from './menu'
import { createOpenFolders } from './openFolders'
import { createQuitFlow, linearCounts, quitDetail, type RunningCounts, type UnsavedCounts } from './quit'
import { selectQuery } from './sessions/fakeQuery'
import { SessionManager } from './sessions/SessionManager'
import { TerminalManager } from './terminal/TerminalManager'
import { createUpdater, type Updater } from './update/updater'

/**
 * Undefined in development, where the SDK finds its binary. Packaged, it cannot be run from inside the asar.
 * Throws if the binary is missing: called per session, so the app still opens and `start` reports it.
 */
function claudeExecutablePath(): string | undefined {
  if (!app.isPackaged) return undefined
  const binary = createRequire(__filename).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  return binary.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

let quitting = (): boolean => false

/** Brings the window forward, a new one if it was closed (the app stays alive on macOS). Set once the app is ready. */
let showWindow: () => void = () => undefined

const openFolders = createOpenFolders((folder) => {
  broadcast('app:openFolder', folder)
  showWindow()
})

// Registered before `whenReady`: a cold `open -a Canopy <dir>` delivers its folder before the app is ready.
app.on('open-file', (e, path) => {
  e.preventDefault()
  openFolders.push(path)
  // The page will find the folder waiting when it loads.
  if (app.isReady()) showWindow()
})

/** Says what `installCli` did, in French, with the line to add when the folder is not on PATH. */
async function installCommand(): Promise<void> {
  const binDir = join(homedir(), '.local', 'bin')
  const options: Electron.MessageBoxOptions = { type: 'info', buttons: ['OK'], message: '' }
  try {
    const r = await installCli({ source: join(process.resourcesPath, 'canopy'), binDir, pathEnv: currentEnv().PATH ?? '' })
    if (r.status === 'conflict') {
      options.type = 'warning'
      options.message = 'La commande canopy n\'a pas été installée.'
      options.detail = `${r.link} existe déjà et n'a pas été créé par Canopy : il n'a pas été modifié.`
    } else {
      options.message = 'La commande canopy est installée.'
      options.detail = r.onPath
        ? `${r.link}\n\nDans un terminal, « canopy . » ouvre le dossier courant dans Canopy.`
        : `${r.link}\n\n${binDir} n'est pas dans le PATH. Ajoute cette ligne à ~/.zshrc, puis ouvre un nouveau terminal :\n\nexport PATH="$HOME/.local/bin:$PATH"`
    }
  } catch (e) {
    options.type = 'error'
    options.message = 'La commande canopy n\'a pas pu être installée.'
    options.detail = e instanceof Error ? e.message : String(e)
  }
  const win = BrowserWindow.getFocusedWindow()
  await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
}

/** Tests run the app without a window on screen, a Dock icon, or taking the focus. */
const hidden = hiddenWindow({ isPackaged: app.isPackaged, env: process.env })
if (hidden && process.platform === 'darwin') app.setActivationPolicy('accessory')

/** `onClose` runs for every close that is not part of a quit already under way. */
function createWindow(onClose: () => void, onRendererGone: () => void): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0D0E10',
    titleBarStyle: 'hiddenInset',
    // Hidden, the page must still paint and run as if shown: the tests drive and capture it.
    ...(hidden ? { show: false, paintWhenInitiallyHidden: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...(hidden ? { backgroundThrottling: false } : {})
    }
  })

  win.on('close', (e) => {
    if (quitting()) return
    e.preventDefault()
    onClose()
  })

  // Nothing a session prints may replace the app's page or open a window of its own.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => { e.preventDefault() })

  // Sessions and terminals live here: a reload gives them their window back.
  const shouldReload = createCrashReload()
  win.webContents.on('render-process-gone', (_e, details) => {
    onRendererGone()
    if (!quitting() && shouldReload(details.reason)) win.webContents.reload()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  const store = new AppStore(join(app.getPath('userData'), 'state.json'), safeStorage)
  // A login shell can take minutes: the window opens on the last known PATH, and new processes get the real env once it resolves.
  startEnv({ persistedPath: store.loginPath, onResolved: (env) => { if (env.PATH) store.setLoginPath(env.PATH) } })
  const sessions = new SessionManager({
    query: selectQuery(query, { isPackaged: app.isPackaged, env: process.env }),
    listSessions,
    getSessionMessages,
    // The personal Claude login is used unless the user saved an API key.
    env: () => ({ ...currentEnv(), ...store.apiKeyEnv() }),
    pathToClaudeCodeExecutable: claudeExecutablePath,
    isTrusted: (repoRoot) => store.isRepoTrusted(repoRoot),
    attachmentsDir: join(app.getPath('userData'), 'attachments')
  })
  const lsp = new LspPool({ env: () => Promise.resolve(currentEnv()) })
  const terminals = new TerminalManager({ spawn: pty.spawn, env: currentEnv })
  const userData = app.getPath('userData')
  const linearClient = new LinearClient(selectLinearOpener(linearOpener({
    store,
    openExternal: (url) => { void openExternalUrl(url, (u) => shell.openExternal(u)).catch((e: unknown) => { console.error('linear consent page', e) }) },
    version: app.getVersion()
  }), { isPackaged: app.isPackaged, env: process.env }), store)
  const linearEdits = new LinearEdits(join(userData, 'linear-pending.json'), linearClient)
  const linearLinked = new LinkedIssues(store, localBranches)
  const linearSync = new LinearSync(join(userData, 'linear-cache.json'), linearClient, () => linearLinked.ids(), undefined,
    () => linearEdits.pending().map((p) => p.id))
  let unsaved: UnsavedCounts = { buffers: 0, drafts: 0, tickets: 0, comments: 0 }
  const running = (): RunningCounts => ({
    sessions: sessions.runningCount(), terminals: terminals.runningCount(), ...unsaved, ...linearCounts(linearEdits.pending())
  })
  // ⌘Q and closing the window both end here: one question if something runs, then everything stops.
  const quit = createQuitFlow({
    counts: running,
    confirm: async (counts) => {
      const options: Electron.MessageBoxOptions = {
        type: 'warning', buttons: ['Quitter', 'Annuler'], defaultId: 1, cancelId: 1,
        message: 'Quitter Canopy ?', detail: quitDetail(counts)
      }
      const win = BrowserWindow.getFocusedWindow()
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return response === 0
    },
    shutdown: () => { sessions.stopAll(); lsp.disposeAll(); terminals.disposeAll(); stopAllWatchers() },
    // Deferred: quitting from inside the `before-quit` that was just cancelled is ignored.
    quit: () => { setImmediate(() => app.quit()) }
  })
  quitting = () => quit.quitting
  app.on('before-quit', (e) => {
    if (quit.quitting) return
    e.preventDefault()
    void quit.request()
  })
  const tickets = new TicketStore()
  registerIpc(store, sessions, lsp, terminals, (counts) => { unsaved = counts }, () => openFolders.take(),
    selectAccountRunner(claudeAuthRunner({ executable: claudeExecutablePath, env: currentEnv }), { isPackaged: app.isPackaged, env: process.env }),
    tickets, new MockupStore())
  const linearIpc = registerLinearIpc({
    handle: (name, fn) => { ipcMain.handle(name, (_e, ...args: unknown[]) => fn(...args)) },
    client: linearClient, edits: linearEdits, sync: linearSync, linked: linearLinked, store,
    launch: {
      tickets, store,
      activity: (cwd) => sessions.activity(cwd),
      sessions: (cwd) => sessions.liveCount(cwd),
      trusted: (cwd) => isConfigTrusted(store, cwd)
    },
    broadcast
  })
  // Never blocks the window: stored tokens only, then the queue left by the last run, then the list.
  void startLinear({ client: linearClient, linked: linearLinked, edits: linearEdits, sync: linearSync, broadcast })
  // Back from sleep: the network is likely back too; the refresh resends what failed.
  powerMonitor.on('resume', () => { void linearIpc.refresh().catch((e: unknown) => { console.error('linear refresh failed', e) }) })
  const stashFile = join(app.getPath('userData'), 'update-stash.json')
  // Only a packaged app can update itself; the hidden test runs must not.
  let updater: Updater | null = null
  if (app.isPackaged && !hidden) {
    updater = createUpdater({
      updater: autoUpdater,
      now: Date.now,
      setInterval,
      broadcast,
      counts: running,
      confirm: async (detail) => {
        const options: Electron.MessageBoxOptions = {
          type: 'warning', buttons: ['Redémarrer', 'Annuler'], defaultId: 1, cancelId: 1,
          message: 'Redémarrer pour mettre à jour ?', detail
        }
        const win = BrowserWindow.getFocusedWindow()
        const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        return response === 0
      },
      finish: (then) => { quit.finish(then) },
      relaunch: () => { app.relaunch(); app.exit(0) },
      stashFile,
      stashTimeoutMs: 5000
    })
    const u = updater
    powerMonitor.on('resume', () => { u.tick() })
    u.start()
  }
  registerUpdateIpc(updater, stashFile)
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({
    isPackaged: app.isPackaged,
    onCloseTab: () => broadcast('menu:closeTab'),
    onInstallCli: () => void installCommand()
  })))
  // What the page held died with it.
  const open = (): void => {
    // The new page asks for its folder when it loads; a folder asked meanwhile waits for it.
    openFolders.reset()
    createWindow(() => void quit.request(), () => { unsaved = { buffers: 0, drafts: 0, tickets: 0, comments: 0 }; openFolders.reset() })
  }
  showWindow = () => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) { open(); return }
    if (hidden) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  open()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
