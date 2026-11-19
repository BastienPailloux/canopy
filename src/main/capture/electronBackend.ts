import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, Notification, screen, systemPreferences, type BrowserWindowConstructorOptions, type Display, type IpcMainEvent } from 'electron'
import type { CaptureFinish, CaptureWorkerJob, CaptureWorkerResult } from '../../shared/capture'
import { clampRegion, type DisplayInfo } from '../../shared/captureGeometry'
import type { CaptureBackend, CaptureSelection, RecordingSession } from './captureFlow'
import { panelPlacement, parseDrag, parseWorkerResult } from './pageMessages'

/**
 * Whether `setContentProtection` keeps the panel out of the stream. The spike could not check it (spec §8):
 * assume it shows, so the panel always stays out of the region.
 */
export const PANEL_HIDDEN_FROM_CAPTURE = false

const PANEL_SIZE = { width: 230, height: 44 }
const NO_PANEL_NOTICE = 'Enregistrement en cours. ⌥⇧⌘5 pour arrêter.'
/** A worker that never answers must not leave Canopy hidden. */
const SCREENSHOT_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 15_000
const FINISH_TIMEOUT_MS = 30_000

const info = (d: Display): DisplayInfo => ({ id: d.id, bounds: { ...d.bounds }, scaleFactor: d.scaleFactor })
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function capturePage(options: BrowserWindowConstructorOptions, query: Record<string, string>): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    ...options,
    webPreferences: {
      preload: join(__dirname, '../preload/capture.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...options.webPreferences
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => { e.preventDefault() })
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(`${dev}/capture/index.html?${new URLSearchParams(query).toString()}`)
  else void win.loadFile(join(__dirname, '../renderer/capture/index.html'), { query })
  return win
}

/** Over everything, full-screen apps included: the user is in another app. */
function onTop(win: BrowserWindow): void {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
}

const BARE: BrowserWindowConstructorOptions = {
  frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
  maximizable: false, fullscreenable: false, skipTaskbar: true, backgroundColor: '#00000000'
}

function selectRegion(): Promise<CaptureSelection | null> {
  const displays = screen.getAllDisplays()
  const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return new Promise((resolve) => {
    const veils = new Map<number, { win: BrowserWindow; display: DisplayInfo }>()
    let done = false
    const end = (sel: CaptureSelection | null): void => {
      if (done) return
      done = true
      ipcMain.off('capture-page:select', onSelect)
      // The veil must be off the screen before a frame is read.
      const open = [...veils.values()].map(v => v.win).filter(w => !w.isDestroyed())
      void Promise.all(open.map(w => new Promise<void>((r) => { w.once('closed', () => { r() }); w.close() }))).then(() => { resolve(sel) })
    }
    function onSelect(e: IpcMainEvent, raw: unknown): void {
      const veil = veils.get(e.sender.id)
      if (!veil) return
      const drag = parseDrag(raw)
      if (!drag) { end(null); return }
      const b = veil.display.bounds
      end({ region: clampRegion({ ...drag, x: drag.x + b.x, y: drag.y + b.y }, veil.display), display: veil.display })
    }
    ipcMain.on('capture-page:select', onSelect)
    for (const d of displays) {
      const win = capturePage({ ...BARE, ...d.bounds, hasShadow: false, enableLargerThanScreen: true, roundedCorners: false, acceptFirstMouse: true }, { role: 'select', display: String(d.id) })
      veils.set(win.webContents.id, { win, display: info(d) })
      onTop(win)
      // macOS keeps a new window below the menu bar; set again, the bounds cover it.
      win.setBounds(d.bounds)
      win.on('closed', () => { end(null) })
      win.webContents.on('render-process-gone', () => { end(null) })
      win.once('ready-to-show', () => {
        // Échap reaches the focused veil only: the one under the pointer.
        if (d.id === under.id) { win.show(); win.focus() } else win.showInactive()
      })
    }
  })
}

async function sourceFor(displayId: number): Promise<string> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const source = sources.find(s => s.display_id === String(displayId)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source) throw new Error('Écran introuvable pour la capture.')
  return source.id
}

interface Worker {
  /** The next result; an error result rejects. */
  expect<K extends CaptureWorkerResult['kind']>(kind: K, timeoutMs: number): Promise<Extract<CaptureWorkerResult, { kind: K }>>
  finish(f: CaptureFinish): void
  /** Destroys the page, which ends the stream and drops its frames. */
  close(): void
}

/** The hidden page that reads the stream: background throttling would slow its sampling down. */
function openWorker(job: Omit<CaptureWorkerJob, 'sourceId'>): Worker {
  const win = capturePage({ width: 320, height: 240, webPreferences: { backgroundThrottling: false } }, { role: 'worker' })
  const id = win.webContents.id
  const queue: CaptureWorkerResult[] = []
  let waiting: ((r: CaptureWorkerResult) => void) | null = null
  const push = (r: CaptureWorkerResult): void => {
    const w = waiting
    if (w) { waiting = null; w(r) } else queue.push(r)
  }
  const onReady = (e: IpcMainEvent): void => {
    if (e.sender.id !== id) return
    sourceFor(job.display.id).then(
      (sourceId) => { if (!win.isDestroyed()) win.webContents.send('capture-page:job', { ...job, sourceId } satisfies CaptureWorkerJob) },
      (err: unknown) => { push({ kind: 'error', message: message(err) }) }
    )
  }
  const onResult = (e: IpcMainEvent, raw: unknown): void => { if (e.sender.id === id) push(parseWorkerResult(raw)) }
  ipcMain.on('capture-page:ready', onReady)
  ipcMain.on('capture-page:result', onResult)
  const gone = (): void => { push({ kind: 'error', message: 'La capture s\'est interrompue.' }) }
  win.webContents.on('render-process-gone', gone)
  win.on('closed', () => {
    ipcMain.off('capture-page:ready', onReady)
    ipcMain.off('capture-page:result', onResult)
    gone()
  })

  const next = (timeoutMs: number): Promise<CaptureWorkerResult> => {
    const queued = queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting = null; resolve({ kind: 'error', message: 'La capture ne répond pas.' }) }, timeoutMs)
      waiting = (r) => { clearTimeout(timer); resolve(r) }
    })
  }
  return {
    async expect(kind, timeoutMs) {
      const r = await next(timeoutMs)
      if (r.kind === 'error') throw new Error(r.message)
      if (r.kind !== kind) throw new Error('Réponse de capture inattendue')
      return r as Extract<CaptureWorkerResult, { kind: typeof kind }>
    },
    finish(f) { if (!win.isDestroyed()) win.webContents.send('capture-page:finish', f) },
    close() { if (!win.isDestroyed()) win.destroy() }
  }
}

/** The floating stop panel, or a notification when it has nowhere to go but over the region. */
function openPanel(sel: CaptureSelection, onStop: () => void): { close(): void } | null {
  const pos = panelPlacement(sel.region, sel.display, screen.getAllDisplays().map(info), PANEL_SIZE, PANEL_HIDDEN_FROM_CAPTURE)
  if (!pos) {
    if (Notification.isSupported()) new Notification({ title: 'Canopy', body: NO_PANEL_NOTICE }).show()
    return null
  }
  // Not focusable: the app under test keeps the focus; acceptFirstMouse lets the button work while Canopy is inactive.
  const win = capturePage({ ...BARE, ...pos, ...PANEL_SIZE, focusable: false, acceptFirstMouse: true }, { role: 'panel' })
  win.setContentProtection(true)
  onTop(win)
  const id = win.webContents.id
  const onPress = (e: IpcMainEvent): void => { if (e.sender.id === id) onStop() }
  ipcMain.on('capture-page:stop', onPress)
  win.on('closed', () => { ipcMain.off('capture-page:stop', onPress) })
  win.once('ready-to-show', () => { win.showInactive() })
  return { close() { if (!win.isDestroyed()) win.destroy() } }
}

function startRecording(sel: CaptureSelection): RecordingSession {
  const worker = openWorker({ mode: 'record', region: sel.region, display: sel.display })
  let stop = (): void => {}
  const stopped = new Promise<void>((r) => { stop = r })
  const started = worker.expect('started', START_TIMEOUT_MS)
  // A worker that cannot start ends the recording at once; finish then says why.
  started.catch(() => { stop() })
  let panel: { close(): void } | null = null
  try { panel = openPanel(sel, () => { stop() }) } catch (e) { worker.close(); throw e }
  const close = (): void => { worker.close(); panel?.close() }
  return {
    stopped,
    async finish(clicks, clicksMissing) {
      try {
        await started
        worker.finish({ clicks, clicksMissing })
        return (await worker.expect('recording', FINISH_TIMEOUT_MS)).recording
      } finally {
        close()
      }
    },
    cancel: close
  }
}

/** The real screen, windows and stream; `mainWindow` is Canopy's window, hidden while the user captures. */
export function createElectronBackend(mainWindow: () => BrowserWindow | null): CaptureBackend {
  return {
    screenGranted: () => systemPreferences.getMediaAccessStatus('screen') === 'granted',
    hideMain: () => { mainWindow()?.hide() },
    showMain: () => {
      const win = mainWindow()
      if (!win) return
      win.show()
      win.focus()
    },
    selectRegion,
    async screenshot(sel) {
      const worker = openWorker({ mode: 'screenshot', region: sel.region, display: sel.display })
      try {
        return { mediaType: 'image/png', base64: (await worker.expect('image', SCREENSHOT_TIMEOUT_MS)).base64 }
      } finally {
        worker.close()
      }
    },
    startRecording
  }
}
