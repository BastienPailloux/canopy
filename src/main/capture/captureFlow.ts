import type { CaptureKind, CaptureResult } from '../../shared/capture'
import type { DisplayInfo, Rect } from '../../shared/captureGeometry'
import { MAX_RECORDING_MS, type Recording } from '../../shared/recording'
import type { UserImage } from '../../shared/update'
import type { ClickEvent, ClickListener } from './clicks'

export interface CaptureSelection { region: Rect; display: DisplayInfo }

export interface RecordingSession {
  /** Resolves when the user presses the panel's stop button, or at once when the stream fails (finish then says why). */
  stopped: Promise<void>
  /** Frees the stream and the windows itself, success or failure. */
  finish(clicks: ClickEvent[], clicksMissing: boolean): Promise<Recording>
  /** Frees everything when the flow fails before reaching `finish`. */
  cancel(): void
}

/** What touches the screen and the windows; faked in tests and E2E. */
export interface CaptureBackend {
  screenGranted(): boolean
  /** Asks macOS for the screen once: only a real capture attempt lists the app in Privacy › Screen Recording. */
  requestScreen(): void
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
    // Set inside a callback: the cast keeps TS from narrowing it to null.
    let started = null as RecordingSession | null
    let finishing = false
    try {
      const { trusted } = await new Promise<{ trusted: boolean }>((resolve) => {
        const cancel = d.setTimer(() => resolve({ trusted: false }), READY_TIMEOUT_MS)
        listener.ready.then((r) => { cancel(); resolve(r) }, () => { cancel(); resolve({ trusted: false }) })
      })
      // The shortcut is ready before the panel shows, so the user can always stop what they see.
      const session = await new Promise<RecordingSession>((resolve, reject) => {
        const unregister = d.registerStop(() => end())
        let s: RecordingSession
        try { s = d.backend.startRecording(sel) } catch (e) { unregister(); reject(e); return }
        started = s
        const cancelTimer = d.setTimer(() => end(), MAX_RECORDING_MS)
        // The first of panel, shortcut, flow.stop() and timer wins; the rest find nothing to do.
        function end(): void {
          if (stopRecording !== end) return
          stopRecording = null
          unregister()
          cancelTimer()
          resolve(s)
        }
        stopRecording = end
        void s.stopped.then(end, end)
      })
      const collected = stopClicks()
      finishing = true
      const recording = await session.finish(collected, !trusted)
      const explainClicks = recording.clicksMissing && !d.clicksExplained()
      if (explainClicks) d.markClicksExplained()
      return { tabId, kind: 'recording', recording, explainClicks }
    } finally {
      stopClicks()
      // A session that never reached finish still holds a stream, a worker and a panel.
      if (started && !finishing) started.cancel()
    }
  }

  async function run(kind: CaptureKind, tabId: string): Promise<CaptureResult> {
    const b = d.backend
    let hidden = false
    try {
      if (!b.screenGranted()) {
        b.requestScreen()
        return { tabId, kind: 'needs-permission' }
      }
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
      // A throw past run's own catch (showMain in its finally) must still free the flow and answer the tab.
      void run(kind, tabId)
        .catch((e: unknown): CaptureResult => ({ tabId, kind: 'error', message: e instanceof Error ? e.message : String(e) }))
        .then((r) => {
          running = false
          try { d.emit(r) } catch (e) { console.error('capture:done failed', e) }
        })
      return true
    },
    stop() { stopRecording?.() }
  }
}
