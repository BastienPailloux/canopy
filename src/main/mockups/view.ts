import { BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import type { DownloadItem, WebContents } from 'electron'
import { pageTitle, parseArtifactUrl, type MockupTitleEvent, type MockupViewBounds, type MockupViewErrorEvent } from '../../shared/mockups'
import { openExternalUrl } from '../externalLinks'

export const MOCKUP_PARTITION = 'persist:claude-ai'

/** Chromium's "navigation aborted": a redirect or a newer navigation, not a failure. */
const ERR_ABORTED = -3

/**
 * Hosts the view's main frame may navigate to: claude.ai and its login providers. Not claudeusercontent.com: artifact
 * content renders in subframes, and a main frame showing user content could pass for claude.ai in a logged-in view.
 */
const VIEW_HOSTS = ['claude.ai', 'accounts.google.com', 'appleid.apple.com']
const VIEW_HOST_SUFFIXES = ['.claude.ai', '.anthropic.com']

/** Whether a navigation of the view to `url` stays in it (https, claude.ai or login); else it goes to the browser. */
export function allowedInView(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false
  const host = u.hostname.toLowerCase()
  return VIEW_HOSTS.includes(host) || VIEW_HOST_SUFFIXES.some((s) => host.endsWith(s))
}

export interface NavigationEvent { kind: 'navigate' | 'redirect'; isMainFrame: boolean; url: string }

/**
 * What the view does with a navigation: subframes and allowed pages go on; a main-frame navigation elsewhere is
 * cancelled and, only when the user started it (a link, not a redirect), opened in the browser.
 */
export function navigationAction(n: NavigationEvent): 'allow' | 'cancel' | 'external' {
  if (!n.isMainFrame || allowedInView(n.url)) return 'allow'
  return n.kind === 'navigate' ? 'external' : 'cancel'
}

/**
 * Whether a `window.open` came from the view's main frame: its referrer has the main frame's origin. A request without
 * a referrer (or from a subframe, e.g. artifact content) is not trusted.
 */
export function fromMainFrame(referrer: string, mainFrameUrl: string): boolean {
  try {
    const origin = new URL(mainFrameUrl).origin
    return origin !== 'null' && new URL(referrer).origin === origin
  } catch { return false }
}

/** A gate letting through at most one call per `intervalMs`; the calls in between are refused (not queued). */
export function rateLimiter(intervalMs: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < intervalMs) return false
    last = t
    return true
  }
}

/** Minimum delay between two pages the view sends to the browser. */
const EXTERNAL_OPEN_INTERVAL_MS = 1000

/**
 * Whether `show` loads the requested URL: always a new one, or after a failed load; for the same mockup URL, also
 * when the view has gone to another artifact (with the e2e page, only the failure counts).
 */
export function needsLoad(o: { last: string | null; requested: string; failed: boolean; override: boolean; currentUrl: string }): boolean {
  if (o.last !== o.requested || o.failed) return true
  return !o.override && elsewhere(o.currentUrl, o.requested)
}

/** Whether the page at `currentUrl` is not the mockup at `mockupUrl`. */
function elsewhere(currentUrl: string, mockupUrl: string): boolean {
  return parseArtifactUrl(currentUrl)?.id !== parseArtifactUrl(mockupUrl)?.id
}

/** A download asked by the view: cancelled, its URL opened in the browser if it is http(s). */
export function onViewDownload(item: Pick<DownloadItem, 'cancel' | 'getURL'>, open: (url: string) => void): void {
  item.cancel()
  const url = item.getURL()
  let protocol = ''
  try { protocol = new URL(url).protocol } catch { return }
  if (protocol === 'https:' || protocol === 'http:') open(url)
}

/** The only permission the claude.ai pages get (their copy buttons). */
const ALLOWED_PERMISSION = 'clipboard-sanitized-write'
let partitionLocked = false

/**
 * Denies the claude.ai partition every permission but the clipboard write, and sends its downloads to the browser,
 * once per process.
 */
function lockPartition(openExternal: (url: string) => Promise<void>): void {
  if (partitionLocked) return
  partitionLocked = true
  const s = session.fromPartition(MOCKUP_PARTITION)
  s.setPermissionRequestHandler((_wc, permission, callback) => { callback(permission === ALLOWED_PERMISSION) })
  s.setPermissionCheckHandler((_wc, permission) => permission === ALLOWED_PERMISSION)
  s.on('will-download', (_e, item) => {
    onViewDownload(item, (url) => { void openExternalUrl(url, openExternal).catch(() => undefined) })
  })
}

/** Integer pixels, never negative. */
export function clampBounds(b: MockupViewBounds): MockupViewBounds {
  const px = (n: number): number => Math.max(0, Math.round(n))
  return { x: px(b.x), y: px(b.y), width: px(b.width), height: px(b.height) }
}

export function parseBounds(raw: unknown): MockupViewBounds {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const { x, y, width, height } = o
  for (const n of [x, y, width, height]) if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('Zone invalide')
  return clampBounds({ x: x as number, y: y as number, width: width as number, height: height as number })
}

/** The page the e2e runs (`CANOPY_FAKE_QUERY`) load instead of claude.ai; never honored in a packaged app. */
export function mockupViewOverride(o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): string | undefined {
  const url = o.env.CANOPY_MOCKUP_VIEW_URL
  return !o.isPackaged && o.env.CANOPY_FAKE_QUERY && url ? url : undefined
}

interface Entry {
  view: WebContentsView
  win: BrowserWindow
  /** The canonical mockup URL asked for, null before the first show. */
  url: string | null
  /** The last main-frame load failed (cleared by the next one that finishes). */
  failed: boolean
}

export interface MockupViewDeps {
  openExternal: (url: string) => Promise<void>
  /** Loaded instead of each mockup URL (e2e). */
  override?: string
}

/**
 * One claude.ai view per window, laid over the renderer's 4b area. The renderer gives the URL and the rectangle,
 * and hides it whenever a modal opens or it leaves 4b: a native view is drawn above the page.
 */
export class MockupViewManager {
  private entries = new Map<number, Entry>()

  constructor(private deps: MockupViewDeps) {}

  /** Canonical URL to show for what the renderer sent, or null if refused. */
  accepts(url: unknown): string | null {
    if (typeof url !== 'string') return null
    if (this.deps.override !== undefined && url === this.deps.override) return url
    return parseArtifactUrl(url)?.url ?? null
  }

  private entry(sender: WebContents): Entry | null {
    const existing = this.entries.get(sender.id)
    if (existing) return existing
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win.isDestroyed()) return null
    lockPartition(this.deps.openExternal)
    const view = new WebContentsView({
      webPreferences: { partition: MOCKUP_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const entry: Entry = { view, win, url: null, failed: false }
    const wc = view.webContents
    const toBrowser = (url: string): void => { void openExternalUrl(url, this.deps.openExternal).catch(() => undefined) }
    // No new windows: the main frame's go to the default browser (at most one a second), the subframes' nowhere;
    // navigation stays in the view only on claude.ai and its login pages.
    const mayOpenExternal = rateLimiter(EXTERNAL_OPEN_INTERVAL_MS)
    wc.setWindowOpenHandler(({ url, referrer }) => {
      if (fromMainFrame(referrer.url, wc.getURL()) && mayOpenExternal()) toBrowser(url)
      return { action: 'deny' }
    })
    const guard = (e: { preventDefault: () => void; url: string; isMainFrame: boolean }, kind: NavigationEvent['kind']): void => {
      const action = navigationAction({ kind, isMainFrame: e.isMainFrame, url: e.url })
      if (action === 'allow') return
      e.preventDefault()
      if (action === 'external') toBrowser(e.url)
    }
    wc.on('will-navigate', (e) => { guard(e, 'navigate') })
    wc.on('will-redirect', (e) => { guard(e, 'redirect') })
    wc.on('page-title-updated', (_e, title) => {
      const url = entry.url
      if (url === null || sender.isDestroyed()) return
      // Only the mockup's own page names it: not the login page it may go through.
      const here = parseArtifactUrl(wc.getURL())?.id
      if (this.deps.override === undefined && (here === undefined || here !== parseArtifactUrl(url)?.id)) return
      const shown = pageTitle(title)
      if (shown !== '') sender.send('canopy:event', 'mockups:title', { url, title: shown } satisfies MockupTitleEvent)
    })
    wc.on('did-finish-load', () => { entry.failed = false })
    wc.on('did-fail-load', (_e, code, description, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      entry.failed = true
      if (entry.url === null || sender.isDestroyed()) return
      const error = description || `Erreur ${code}`
      sender.send('canopy:event', 'mockups:viewError', { url: entry.url, error } satisfies MockupViewErrorEvent)
    })
    // A reloaded page knows nothing of the view: it would stay drawn over it.
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) view.setVisible(false)
    })
    sender.once('destroyed', () => { this.dispose(sender.id) })
    win.contentView.addChildView(view)
    this.entries.set(sender.id, entry)
    return entry
  }

  private dispose(id: number): void {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    if (!e.win.isDestroyed()) e.win.contentView.removeChildView(e.view)
    if (!e.view.webContents.isDestroyed()) e.view.webContents.close()
  }

  /**
   * Shows `url` (canonical, see `accepts`) over `bounds`; the same URL again is not reloaded, unless its load failed
   * or the view has gone to another artifact meanwhile.
   */
  show(sender: WebContents, url: string, bounds: MockupViewBounds): void {
    const e = this.entry(sender)
    if (!e) return
    e.view.setBounds(clampBounds(bounds))
    e.view.setVisible(true)
    const override = this.deps.override !== undefined
    if (!needsLoad({ last: e.url, requested: url, failed: e.failed, override, currentUrl: e.view.webContents.getURL() })) return
    e.url = url
    e.failed = false
    void e.view.webContents.loadURL(this.deps.override ?? url).catch(() => undefined)
  }

  setBounds(sender: WebContents, bounds: MockupViewBounds): void {
    this.entries.get(sender.id)?.view.setBounds(clampBounds(bounds))
  }

  hide(sender: WebContents): void {
    this.entries.get(sender.id)?.view.setVisible(false)
  }

  /** Reloads the mockup shown; a view gone to another artifact meanwhile loads the mockup's URL again. */
  reload(sender: WebContents): void {
    const e = this.entries.get(sender.id)
    if (!e || e.url === null) return
    const wc = e.view.webContents
    if (elsewhere(wc.getURL(), e.url)) {
      void wc.loadURL(this.deps.override ?? e.url).catch(() => undefined)
    } else wc.reload()
  }
}

export function registerMockupViewIpc(views: MockupViewManager): void {
  ipcMain.handle('mockupView:show', (e, url: unknown, bounds: unknown) => {
    const shown = views.accepts(url)
    if (shown === null) throw new Error('Lien de maquette invalide')
    views.show(e.sender, shown, parseBounds(bounds))
  })
  ipcMain.handle('mockupView:bounds', (e, bounds: unknown) => { views.setBounds(e.sender, parseBounds(bounds)) })
  ipcMain.handle('mockupView:hide', (e) => { views.hide(e.sender) })
  ipcMain.handle('mockupView:reload', (e) => { views.reload(e.sender) })
}
