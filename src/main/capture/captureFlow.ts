import type { CaptureKind, CaptureResult } from '../../shared/capture'
import type { DisplayInfo, Rect } from '../../shared/captureGeometry'
import { MAX_RECORDING_MS, type Recording } from '../../shared/recording'
import type { UserImage } from '../../shared/update'
import type { CLICK_PERMISSION, ClickEvent, ClickListener } from './clicks'

export interface CaptureSelection { region: Rect; display: DisplayInfo }

export interface RecordingSession {
  /**
   * Resolves when the user presses the panel's stop button, or as soon as the stream fails, before or after
   * it started (a worker that crashes or loses its track): finish then says why.
   */
  stopped: Promise<void>
  /** Resolves once the first frame is read; never resolves for a stream that fails first. */
  started: Promise<void>
  /** Whether a stop panel shows: without it, only the shortcut can stop the recording. */
  hasPanel: boolean
  /** A click from the helper, as it comes: the worker keeps only the frames around it. */
  click(c: ClickEvent): void
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
  /** Null when the user cancels, or when `signal` aborts. */
  selectRegion(signal: AbortSignal): Promise<CaptureSelection | null>
  /** Rejects soon after `signal` aborts: a quit must not wait for a slow capture. */
  screenshot(sel: CaptureSelection, signal: AbortSignal): Promise<UserImage>
  startRecording(sel: CaptureSelection): RecordingSession
  /** Without a panel, says the stop shortcut. */
  showStopNotice(): void
}

export interface CaptureFlowDeps {
  backend: CaptureBackend
  clicks: () => ClickListener
  /** Registers the global stop shortcut; another app may hold it already. */
  registerStop: (onStop: () => void) => { registered: boolean; unregister: () => void }
  /** Returns the cancel. */
  setTimer: (fn: () => void, ms: number) => () => void
  /** Without one, missing clicks mean the helper failed: nothing the user can grant. */
  clickPermission: typeof CLICK_PERMISSION
  clicksExplained: () => boolean
  markClicksExplained: () => void
  emit: (r: CaptureResult) => void
}

/** A helper that never says `ready` must not hold the recording back. */
const READY_TIMEOUT_MS = 2000
const NO_STOP = "Impossible d'afficher le bouton d'arrêt ni d'enregistrer le raccourci ⌥⇧⌘5 : enregistrement annulé."

class Cancelled extends Error {}

export function createCaptureFlow(d: CaptureFlowDeps): { start(kind: CaptureKind, tabId: string): boolean; stop(): void; cancelAll(): void } {
  let running = false
  let stopRecording: (() => void) | null = null
  let abort: AbortController | null = null

  async function record(tabId: string, sel: CaptureSelection, signal: AbortSignal): Promise<CaptureResult> {
    const listener = d.clicks()
    let stopListener: (() => ClickEvent[]) | null = () => listener.stop()
    const stopClicks = (): ClickEvent[] => { const s = stopListener; stopListener = null; return s ? s() : [] }
    // Set inside a callback: the cast keeps TS from narrowing it to null.
    let started = null as RecordingSession | null
    let finishing = false
    // A quit frees the stream and the windows at once, whatever the recording is waiting for.
    const onAbort = (): void => { stopClicks(); started?.cancel() }
    signal.addEventListener('abort', onAbort)
    try {
      const { trusted } = await new Promise<{ trusted: boolean }>((resolve, reject) => {
        const cancel = d.setTimer(() => resolve({ trusted: false }), READY_TIMEOUT_MS)
        signal.addEventListener('abort', () => { cancel(); reject(new Cancelled()) })
        listener.ready.then((r) => { cancel(); resolve(r) }, () => { cancel(); resolve({ trusted: false }) })
      })
      // The shortcut is ready before the panel shows, so the user can always stop what they see.
      const session = await new Promise<RecordingSession>((resolve, reject) => {
        const stop = d.registerStop(() => end())
        let s: RecordingSession
        try { s = d.backend.startRecording(sel) } catch (e) { stop.unregister(); reject(e); return }
        started = s
        if (!stop.registered && !s.hasPanel) { stop.unregister(); reject(new Error(NO_STOP)); return }
        if (!s.hasPanel) d.backend.showStopNotice()
        if (trusted) listener.onClick((c) => { s.click(c) })
        let cancelTimer = (): void => {}
        // Counted from the first frame: a slow start must not eat into the user's two minutes.
        void s.started.then(() => { if (stopRecording === end) cancelTimer = d.setTimer(() => end(), MAX_RECORDING_MS) }, () => {})
        // The first of panel, shortcut, flow.stop() and timer wins; the rest find nothing to do.
        function end(): void {
          if (stopRecording !== end) return
          stopRecording = null
          stop.unregister()
          cancelTimer()
          signal.removeEventListener('abort', cancelled)
          resolve(s)
        }
        function cancelled(): void {
          if (stopRecording !== end) return
          stopRecording = null
          stop.unregister()
          cancelTimer()
          reject(new Cancelled())
        }
        stopRecording = end
        signal.addEventListener('abort', cancelled)
        void s.stopped.then(end, end)
      })
      const collected = stopClicks()
      finishing = true
      const recording = await session.finish(collected, !trusted)
      const explainClicks = recording.clicksMissing && d.clickPermission !== 'none' && !d.clicksExplained()
      if (explainClicks) d.markClicksExplained()
      return { tabId, kind: 'recording', recording, explainClicks }
    } finally {
      signal.removeEventListener('abort', onAbort)
      stopClicks()
      // A session that never reached finish still holds a stream, a worker and a panel.
      if (started && !finishing) started.cancel()
    }
  }

  async function run(kind: CaptureKind, tabId: string, signal: AbortSignal): Promise<CaptureResult> {
    const b = d.backend
    let hidden = false
    try {
      if (!b.screenGranted()) {
        b.requestScreen()
        return { tabId, kind: 'needs-permission' }
      }
      b.hideMain()
      hidden = true
      const sel = await b.selectRegion(signal)
      if (!sel || signal.aborted) return { tabId, kind: 'cancelled' }
      if (kind === 'screenshot') {
        const image = await b.screenshot(sel, signal)
        // A cancel the backend did not hear in time still wins: the image was not asked for anymore.
        return signal.aborted ? { tabId, kind: 'cancelled' } : { tabId, kind: 'screenshot', image }
      }
      return await record(tabId, sel, signal)
    } catch (e) {
      // A quit during finish closes the worker under it: that failure is the cancel itself.
      if (e instanceof Cancelled || signal.aborted) return { tabId, kind: 'cancelled' }
      return { tabId, kind: 'error', message: e instanceof Error ? e.message : String(e) }
    } finally {
      if (hidden) b.showMain()
    }
  }

  return {
    start(kind, tabId) {
      if (running) return false
      running = true
      const controller = new AbortController()
      abort = controller
      // A throw past run's own catch (showMain in its finally) must still free the flow and answer the tab.
      void run(kind, tabId, controller.signal)
        .catch((e: unknown): CaptureResult => ({ tabId, kind: 'error', message: e instanceof Error ? e.message : String(e) }))
        .then((r) => {
          running = false
          if (abort === controller) abort = null
          try { d.emit(r) } catch (e) { console.error('capture:done failed', e) }
        })
      return true
    },
    stop() { stopRecording?.() },
    cancelAll() { abort?.abort() }
  }
}
