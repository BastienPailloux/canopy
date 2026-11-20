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

/** A click in global points, epoch ms: one of the click helper's events. */
export interface CaptureClick { t: number; x: number; y: number }

/** Clicks in global points, epoch ms: the click helper's events, all of them, those already sent live included. */
export interface CaptureFinish { clicks: CaptureClick[]; clicksMissing: boolean }

const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A click as the worker page receives it; anything else is dropped. */
export function parseCaptureClick(v: unknown): CaptureClick | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { t, x, y } = v as Record<string, unknown>
  return isFinite(t) && isFinite(x) && isFinite(y) ? { t, x, y } : null
}

/** The recording's acknowledged start as the panel receives it, epoch ms; anything else is dropped. */
export function parseStartedAt(v: unknown): number | null {
  return isFinite(v) && v >= 0 ? v : null
}

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
  /** Worker: asks for its job once its listeners are set. Panel: says it can show the start. */
  ready(): void
  onJob(fn: (job: CaptureWorkerJob) => void): void
  /** Worker: each click while recording, as it comes. */
  onClick(fn: (c: CaptureClick) => void): void
  onFinish(fn: (f: CaptureFinish) => void): void
  /** Panel: when the first frame was read, epoch ms, the origin of main's 2-minute timer. */
  onStarted(fn: (startedAt: number) => void): void
  result(r: CaptureWorkerResult): void
}
