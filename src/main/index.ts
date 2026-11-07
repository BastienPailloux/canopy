import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { AppStore } from './appStore'
import { loginShellEnv } from './env'
import { setGitEnv } from './git/exec'
import { registerIpc } from './ipc'
import { SessionManager } from './sessions/SessionManager'

/** Undefined in development, where the SDK finds its binary. Packaged, it cannot be run from inside the asar. */
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
  const sessions = new SessionManager({
    query,
    listSessions,
    getSessionMessages,
    env: () => env,
    pathToClaudeCodeExecutable: claudeExecutablePath()
  })
  app.on('before-quit', () => sessions.stopAll())
  registerIpc(new AppStore(join(app.getPath('userData'), 'state.json')), sessions)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
