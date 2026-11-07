/** Widths of the two side panels, chosen by dragging their edge. */
export interface Layout {
  /** Width of the full worktree list, kept while it shows as a rail. */
  left: number
  /** The worktree list shows as a narrow rail of initials. */
  rail: boolean
  right: number
}

export const LEFT_DEFAULT = 256
export const LEFT_MIN = 200
export const LEFT_MAX = 480
/** Width of the worktree list shown as a rail. */
export const RAIL_WIDTH = 52
/** Dragged below this, the list gives way to the rail. */
export const RAIL_BELOW = 140
export const RIGHT_DEFAULT = 300
export const RIGHT_MIN = 240

export const DEFAULT_LAYOUT: Layout = { left: LEFT_DEFAULT, rail: false, right: RIGHT_DEFAULT }

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

/** `pointer`: where the left edge is dragged to, from the window's left. `full`: the width to keep for when the rail opens again. */
export function dragLeft(pointer: number, full: number = LEFT_DEFAULT): { width: number; rail: boolean } {
  if (pointer < RAIL_BELOW) return { width: full, rail: true }
  return { width: clamp(Math.round(pointer), LEFT_MIN, LEFT_MAX), rail: false }
}

/** A keyboard step on the left edge: past the narrowest list it becomes the rail, and any step outward opens the rail. */
export function stepLeft(layout: Pick<Layout, 'left' | 'rail'>, delta: number): { width: number; rail: boolean } {
  if (layout.rail) return { width: layout.left, rail: delta <= 0 }
  const next = layout.left + delta
  if (next < LEFT_MIN) return { width: layout.left, rail: true }
  return { width: Math.min(LEFT_MAX, next), rail: false }
}

/** `moved`: how far the edge went left since the drag began. Never more than half the window. */
export function dragRight(start: number, moved: number, windowWidth: number): number {
  return clamp(Math.round(start + moved), RIGHT_MIN, Math.max(RIGHT_MIN, Math.floor(windowWidth / 2)))
}

/** A saved layout, or the defaults for whatever is missing or wrong. */
export function parseLayout(raw: string | null): Layout {
  let v: unknown
  try { v = raw === null ? null : JSON.parse(raw) } catch { v = null }
  const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  return {
    left: num(o.left) ? clamp(o.left, LEFT_MIN, LEFT_MAX) : LEFT_DEFAULT,
    rail: typeof o.rail === 'boolean' ? o.rail : false,
    right: num(o.right) ? Math.max(RIGHT_MIN, o.right) : RIGHT_DEFAULT
  }
}

/** Up to two letters standing for a worktree in the rail: the start of the last two words of its last segment. */
export function railInitials(label: string): string {
  const last = label.split(/[/\s]/).filter(Boolean).pop() ?? ''
  const words = last.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return '?'
  const picked = words.length === 1 ? words[0].slice(0, 2) : words.slice(-2).map((w) => w[0]).join('')
  return picked.toUpperCase()
}
