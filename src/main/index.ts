import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { AppStore } from './appStore'
import { loginShellEnv } from './env'
import { setGitEnv } from './git/exec'
import { registerIpc } from './ipc'
import { selectQuery } from './sessions/fakeQuery'
import { SessionManager } from './sessions/SessionManager'

/**
 * Undefined in development, where the SDK finds its binary. Packaged, it cannot be run from inside the asar.
 * Throws if the binary is missing: called per session, so the app still opens and `start` reports it.
 */
function claudeExecutablePath(): string | undefined {
  if (!app.isPackaged) return undefined
  const binary = createRequire(__filename).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  return binary.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

function createWindow(): void {
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

  // Nothing a session prints may replace the app's page or open a window of its own.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => { e.preventDefault() })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  // Before any git call: git must see the user's login shell env (PATH, config).
  const env = await loginShellEnv()
  setGitEnv({ ...env, GIT_OPTIONAL_LOCKS: '0' })
  const store = new AppStore(join(app.getPath('userData'), 'state.json'))
  const sessions = new SessionManager({
    query: selectQuery(query, { isPackaged: app.isPackaged, env: process.env }),
    listSessions,
    getSessionMessages,
    env: () => env,
    pathToClaudeCodeExecutable: claudeExecutablePath,
    isTrusted: (repoRoot) => store.isRepoTrusted(repoRoot)
  })
  app.on('before-quit', () => sessions.stopAll())
  registerIpc(store, sessions)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
