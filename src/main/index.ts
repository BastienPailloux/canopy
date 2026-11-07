import { app, BrowserWindow, dialog, Menu, safeStorage } from 'electron'
import * as pty from 'node-pty'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { AppStore } from './appStore'
import { LspPool } from './code/lsp'
import { stopAllWatchers } from './code/watchers'
import { createCrashReload } from './crashReload'
import { currentEnv, startEnv } from './env'
import { broadcast, registerIpc } from './ipc'
import { menuTemplate } from './menu'
import { createQuitFlow, quitDetail, type UnsavedCounts } from './quit'
import { selectQuery } from './sessions/fakeQuery'
import { SessionManager } from './sessions/SessionManager'
import { TerminalManager } from './terminal/TerminalManager'

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

/** `onClose` runs for every close that is not part of a quit already under way. */
function createWindow(onClose: () => void, onRendererGone: () => void): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0D0E10',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
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
    isTrusted: (repoRoot) => store.isRepoTrusted(repoRoot)
  })
  const lsp = new LspPool({ env: () => Promise.resolve(currentEnv()) })
  const terminals = new TerminalManager({ spawn: pty.spawn, env: currentEnv })
  let unsaved: UnsavedCounts = { buffers: 0, drafts: 0 }
  // ⌘Q and closing the window both end here: one question if something runs, then everything stops.
  const quit = createQuitFlow({
    counts: () => ({ sessions: sessions.runningCount(), terminals: terminals.runningCount(), ...unsaved }),
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
  registerIpc(store, sessions, lsp, terminals, (counts) => { unsaved = counts })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ isPackaged: app.isPackaged, onCloseTab: () => broadcast('menu:closeTab') })))
  // What the page held died with it.
  const open = (): void => createWindow(() => void quit.request(), () => { unsaved = { buffers: 0, drafts: 0 } })
  open()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
