import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { AppStore } from './appStore'
import { loginShellEnv } from './env'
import { setGitEnv } from './git/exec'
import { registerIpc } from './ipc'

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
  setGitEnv({ ...(await loginShellEnv()), GIT_OPTIONAL_LOCKS: '0' })
  registerIpc(new AppStore(join(app.getPath('userData'), 'state.json')))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
