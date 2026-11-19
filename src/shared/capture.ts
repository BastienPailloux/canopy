import type { Recording } from './recording'
import type { DisplayInfo, Rect } from './captureGeometry'
import type { UserImage } from './update'

export type CaptureKind = 'screenshot' | 'recording'

/** Payload of the `capture:done` event, for the composer of tab `tabId`. */
export type CaptureResult =
  | { tabId: string; kind: 'screenshot'; image: UserImage }
  /** `explainClicks`: clicks were missing and the user was never told why. */
  | { tabId: string; kind: 'recording'; recording: Recording; explainClicks: boolean }
  | { tabId: string; kind: 'cancelled' }
  | { tabId: string; kind: 'needs-permission' }
  | { tabId: string; kind: 'error'; message: string }

/** What main asks the hidden worker page to do with the display's stream. */
export interface CaptureWorkerJob {
  mode: 'screenshot' | 'record'
  /** `desktopCapturer` source of the display. */
  sourceId: string
  region: Rect
  display: DisplayInfo
}

/** Clicks in global points, epoch ms: the click helper's events. */
export interface CaptureFinish { clicks: { t: number; x: number; y: number }[]; clicksMissing: boolean }

export type CaptureWorkerResult =
  | { kind: 'started' }
  /** image/png */
  | { kind: 'image'; base64: string }
  | { kind: 'recording'; recording: Recording }
  | { kind: 'error'; message: string }

export type CapturePageRole = 'select' | 'panel' | 'worker'

/** `window.captureBridge`, the only API of the capture pages: nothing from `CanopyApi`. */
export interface CaptureBridge {
  role: CapturePageRole | null
  /** Selector: the drag in page points, or null for Échap. */
  select(drag: Rect | null): void
  /** Panel: the stop button. */
  stop(): void
  /** Worker: asks for its job once its listeners are set. */
  ready(): void
  onJob(fn: (job: CaptureWorkerJob) => void): void
  onFinish(fn: (f: CaptureFinish) => void): void
  result(r: CaptureWorkerResult): void
}
