import type { CaptureWorkerResult } from '../../shared/capture'
import { panelPosition, type DisplayInfo, type Rect } from '../../shared/captureGeometry'
import type { Recording } from '../../shared/recording'
import { isRecording } from '../sessions/validate'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Far beyond any screen, short of numbers that would break the geometry. */
const MAX_COORD = 100_000
const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD

/** A selector's drag in page points; anything malformed reads as a cancel. */
export function parseDrag(v: unknown): Rect | null {
  if (!isRecord(v)) return null
  const { x, y, width, height } = v
  if (!isCoord(x) || !isCoord(y) || !isCoord(width) || !isCoord(height)) return null
  return { x, y, width, height }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const isBase64 = (v: unknown): v is string => typeof v === 'string' && v !== '' && BASE64.test(v)
const MAX_MESSAGE = 500
const INVALID: CaptureWorkerResult = { kind: 'error', message: 'Réponse de capture invalide' }

/** What the worker page sends, checked like anything from a renderer: a bad one becomes an error. */
export function parseWorkerResult(v: unknown): CaptureWorkerResult {
  if (!isRecord(v)) return INVALID
  switch (v.kind) {
    case 'started': return { kind: 'started' }
    case 'image': return isBase64(v.base64) ? { kind: 'image', base64: v.base64 } : INVALID
    case 'recording': {
      const r = v.recording
      const valid = isRecording(r) && (r as Recording).frames.every(f => isBase64(f.base64))
      return valid ? { kind: 'recording', recording: r as Recording } : INVALID
    }
    case 'error': return typeof v.message === 'string' ? { kind: 'error', message: v.message.slice(0, MAX_MESSAGE) } : INVALID
    default: return INVALID
  }
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Where the recording panel goes. Unless it is hidden from capture, it must stay out of the region:
 * on another display when the region leaves no room, else nowhere (null).
 */
export function panelPlacement(region: Rect, display: DisplayInfo, displays: DisplayInfo[], panel: { width: number; height: number }, hiddenFromCapture: boolean): { x: number; y: number } | null {
  const pos = panelPosition(region, display, panel)
  if (hiddenFromCapture || !overlaps({ ...pos, ...panel }, region)) return pos
  const other = displays.find(d => d.id !== display.id)
  // The other display's whole bounds as the region sends the panel to its corner.
  return other ? panelPosition(other.bounds, other, panel) : null
}
