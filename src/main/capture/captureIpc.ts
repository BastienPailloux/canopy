import type { CaptureKind } from '../../shared/capture'
import type { CLICK_PERMISSION } from './clicks'

const PANE = 'x-apple.systempreferences:com.apple.preference.security?'
const MAX_TAB_ID = 200

export function parseCaptureKind(v: unknown): CaptureKind {
  if (v !== 'screenshot' && v !== 'recording') throw new Error('Capture invalide')
  return v
}

export function parseTabId(v: unknown): string {
  if (typeof v !== 'string' || v === '' || v.length > MAX_TAB_ID) throw new Error('Onglet invalide')
  return v
}

/** Fixed URLs only: the renderer picks a pane, never the URL. Without a click permission, Accessibility is a harmless fallback. */
export function captureSettingsUrl(which: unknown, permission: typeof CLICK_PERMISSION): string {
  if (which === 'screen') return `${PANE}Privacy_ScreenCapture`
  if (which === 'clicks') return `${PANE}${permission === 'input-monitoring' ? 'Privacy_ListenEvent' : 'Privacy_Accessibility'}`
  throw new Error('Réglage invalide')
}

export function registerCaptureIpc(o: {
  handle: (name: string, fn: (...args: unknown[]) => unknown) => void
  flow: { start(kind: CaptureKind, tabId: string): boolean; stop(): void }
  permission: typeof CLICK_PERMISSION
  openExternal: (url: string) => Promise<void>
}): void {
  o.handle('capture:start', (kind, tabId) => o.flow.start(parseCaptureKind(kind), parseTabId(tabId)))
  o.handle('capture:stop', () => { o.flow.stop() })
  o.handle('capture:openSettings', (which) => o.openExternal(captureSettingsUrl(which, o.permission)))
}
