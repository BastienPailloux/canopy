import type { CaptureKind, CaptureResult } from '../../shared/capture'
import type { DisplayInfo, Rect } from '../../shared/captureGeometry'
import { MAX_RECORDING_MS, type Recording } from '../../shared/recording'
import type { UserImage } from '../../shared/update'
import type { ClickEvent, ClickListener } from './clicks'

export interface CaptureSelection { region: Rect; display: DisplayInfo }

export interface RecordingSession {
  /** Resolves when the user presses the panel's stop button. */
  stopped: Promise<void>
  finish(clicks: ClickEvent[], clicksMissing: boolean): Promise<Recording>
}

/** What touches the screen and the windows; faked in tests and E2E. */
export interface CaptureBackend {
  screenGranted(): boolean
  hideMain(): void
  showMain(): void
  /** Null when the user cancels. */
  selectRegion(): Promise<CaptureSelection | null>
  screenshot(sel: CaptureSelection): Promise<UserImage>
  startRecording(sel: CaptureSelection): RecordingSession
}

export interface CaptureFlowDeps {
  backend: CaptureBackend
  clicks: () => ClickListener
  /** Registers the global stop shortcut; returns its unregister. */
  registerStop: (onStop: () => void) => () => void
  /** Returns the cancel. */
  setTimer: (fn: () => void, ms: number) => () => void
  clicksExplained: () => boolean
  markClicksExplained: () => void
  emit: (r: CaptureResult) => void
}

/** A helper that never says `ready` must not hold the recording back. */
const READY_TIMEOUT_MS = 2000

export function createCaptureFlow(d: CaptureFlowDeps): { start(kind: CaptureKind, tabId: string): boolean; stop(): void } {
  let running = false
  let stopRecording: (() => void) | null = null

  async function record(tabId: string, sel: CaptureSelection): Promise<CaptureResult> {
    const listener = d.clicks()
    let stopListener: (() => ClickEvent[]) | null = () => listener.stop()
    const stopClicks = (): ClickEvent[] => { const s = stopListener; stopListener = null; return s ? s() : [] }
    try {
      const { trusted } = await new Promise<{ trusted: boolean }>((resolve) => {
        const cancel = d.setTimer(() => resolve({ trusted: false }), READY_TIMEOUT_MS)
        listener.ready.then((r) => { cancel(); resolve(r) }, () => { cancel(); resolve({ trusted: false }) })
      })
      const session = d.backend.startRecording(sel)
      await new Promise<void>((resolve) => {
        const unregister = d.registerStop(() => end())
        const cancelTimer = d.setTimer(() => end(), MAX_RECORDING_MS)
        // The first of panel, shortcut, flow.stop() and timer wins; the rest find nothing to do.
        function end(): void {
          if (stopRecording !== end) return
          stopRecording = null
          unregister()
          cancelTimer()
          resolve()
        }
        stopRecording = end
        void session.stopped.then(end, end)
      })
      const recording = await session.finish(stopClicks(), !trusted)
      const explainClicks = recording.clicksMissing && !d.clicksExplained()
      if (explainClicks) d.markClicksExplained()
      return { tabId, kind: 'recording', recording, explainClicks }
    } finally {
      stopClicks()
    }
  }

  async function run(kind: CaptureKind, tabId: string): Promise<CaptureResult> {
    const b = d.backend
    let hidden = false
    try {
      if (!b.screenGranted()) return { tabId, kind: 'needs-permission' }
      b.hideMain()
      hidden = true
      const sel = await b.selectRegion()
      if (!sel) return { tabId, kind: 'cancelled' }
      if (kind === 'screenshot') return { tabId, kind: 'screenshot', image: await b.screenshot(sel) }
      return await record(tabId, sel)
    } catch (e) {
      return { tabId, kind: 'error', message: e instanceof Error ? e.message : String(e) }
    } finally {
      if (hidden) b.showMain()
    }
  }

  return {
    start(kind, tabId) {
      if (running) return false
      running = true
      void run(kind, tabId).then((r) => { running = false; d.emit(r) })
      return true
    },
    stop() { stopRecording?.() }
  }
}
