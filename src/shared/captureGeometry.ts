import { MAX_FRAME_SIDE } from './recording'

/** Global screen points (Electron `screen` API: top-left origin) unless a name says `px`. */
export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayInfo { id: number; bounds: Rect; scaleFactor: number }

/** Normalizes a drag (possibly negative size) and clamps it to the display; a drag thin on either side is a click, so the whole display. */
export function clampRegion(drag: Rect, display: DisplayInfo): Rect {
  const b = display.bounds
  const x1 = Math.min(drag.x, drag.x + drag.width)
  const x2 = Math.max(drag.x, drag.x + drag.width)
  const y1 = Math.min(drag.y, drag.y + drag.height)
  const y2 = Math.max(drag.y, drag.y + drag.height)
  const left = Math.max(b.x, Math.min(x1, b.x + b.width))
  const right = Math.max(b.x, Math.min(x2, b.x + b.width))
  const top = Math.max(b.y, Math.min(y1, b.y + b.height))
  const bottom = Math.max(b.y, Math.min(y2, b.y + b.height))
  const width = right - left
  const height = bottom - top
  // A zero side would divide by zero when clicks are mapped into the image.
  if (width < 4 || height < 4) return { ...b }
  return { x: left, y: top, width, height }
}

/** Region in pixels of the display's stream (bounds × scaleFactor, but the real stream size wins). */
export function regionInStream(region: Rect, display: DisplayInfo, stream: { width: number; height: number }): Rect {
  const sx = stream.width / display.bounds.width
  const sy = stream.height / display.bounds.height
  return {
    x: Math.round((region.x - display.bounds.x) * sx),
    y: Math.round((region.y - display.bounds.y) * sy),
    width: Math.round(region.width * sx),
    height: Math.round(region.height * sy)
  }
}

/** Scales down so the longest side fits `maxSide`; never upscales. */
export function fitSize(width: number, height: number, maxSide = MAX_FRAME_SIDE): { width: number; height: number } {
  const ratio = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

/** Maps a click in global points to pixels of the captured image; null when outside the region. */
export function toImagePoint(click: { x: number; y: number }, region: Rect, image: { width: number; height: number }): { x: number; y: number } | null {
  const dx = click.x - region.x
  const dy = click.y - region.y
  if (dx < 0 || dy < 0 || dx > region.width || dy > region.height) return null
  return { x: Math.round(dx * image.width / region.width), y: Math.round(dy * image.height / region.height) }
}

/** Places the panel below the region, else above, else in the display's bottom-right corner. */
export function panelPosition(region: Rect, display: DisplayInfo, panel: { width: number; height: number }, margin = 12): { x: number; y: number } {
  const b = display.bounds
  const x = Math.max(b.x, Math.min(region.x, b.x + b.width - panel.width))
  const below = region.y + region.height + margin
  if (below + panel.height <= b.y + b.height) return { x, y: below }
  const above = region.y - margin - panel.height
  if (above >= b.y) return { x, y: above }
  return { x: b.x + b.width - panel.width - margin, y: b.y + b.height - panel.height - margin }
}
