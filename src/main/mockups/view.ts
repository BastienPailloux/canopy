import { BrowserWindow, ipcMain, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { pageTitle, parseArtifactUrl, type MockupTitleEvent, type MockupViewBounds, type MockupViewErrorEvent } from '../../shared/mockups'
import { openExternalUrl } from '../externalLinks'

export const MOCKUP_PARTITION = 'persist:claude-ai'

/** Chromium's "navigation aborted": a redirect or a newer navigation, not a failure. */
const ERR_ABORTED = -3

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
    const view = new WebContentsView({
      webPreferences: { partition: MOCKUP_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const entry: Entry = { view, win, url: null }
    const wc = view.webContents
    // Free navigation inside the view (login); new windows go to the default browser.
    wc.setWindowOpenHandler(({ url }) => {
      void openExternalUrl(url, this.deps.openExternal).catch(() => undefined)
      return { action: 'deny' }
    })
    wc.on('page-title-updated', (_e, title) => {
      const url = entry.url
      if (url === null || sender.isDestroyed()) return
      // Only the mockup's own page names it: not the login page it may go through.
      const here = parseArtifactUrl(wc.getURL())
      if (this.deps.override === undefined && here?.url !== url) return
      const shown = pageTitle(title)
      if (shown !== '') sender.send('canopy:event', 'mockups:title', { url, title: shown } satisfies MockupTitleEvent)
    })
    wc.on('did-fail-load', (_e, code, description, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED || entry.url === null || sender.isDestroyed()) return
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

  /** Shows `url` (canonical, see `accepts`) over `bounds`; the same URL again is not reloaded. */
  show(sender: WebContents, url: string, bounds: MockupViewBounds): void {
    const e = this.entry(sender)
    if (!e) return
    e.view.setBounds(clampBounds(bounds))
    e.view.setVisible(true)
    if (e.url === url) return
    e.url = url
    void e.view.webContents.loadURL(this.deps.override ?? url).catch(() => undefined)
  }

  setBounds(sender: WebContents, bounds: MockupViewBounds): void {
    this.entries.get(sender.id)?.view.setBounds(clampBounds(bounds))
  }

  hide(sender: WebContents): void {
    this.entries.get(sender.id)?.view.setVisible(false)
  }

  reload(sender: WebContents): void {
    const e = this.entries.get(sender.id)
    if (e && e.url !== null) e.view.webContents.reload()
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
