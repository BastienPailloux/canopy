// Rasterizes build/icon.svg to a transparent 1024 px PNG with Electron (qlmanage paints a white background).
// Usage: electron build/render-icon.cjs <out.png>
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`))
  await new Promise((r) => setTimeout(r, 500))
  const image = await win.webContents.capturePage()
  writeFileSync(process.argv[2], image.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
