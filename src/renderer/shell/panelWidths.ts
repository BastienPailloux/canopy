/** Widths of the side panels, chosen by dragging their edge, and which of them are folded away. */
export interface Layout {
  /** Width of the full worktree list, kept while it shows as a rail. */
  left: number
  /** The worktree list shows as a narrow rail of initials. */
  rail: boolean
  right: number
  /** Width of the Code screen's file list, kept while it is folded. */
  tree: number
  /** The file list is folded into a strip. */
  treeRail: boolean
  /** The Code screen fills the window: no worktree list, no file list. */
  focus: boolean
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

export const TREE_DEFAULT = 270

/** How narrow and wide a panel that folds into a rail may be, and below what it folds. */
export interface FoldBounds { min: number; max: number; railBelow: number }
export const LEFT_BOUNDS: FoldBounds = { min: LEFT_MIN, max: LEFT_MAX, railBelow: RAIL_BELOW }
export const TREE_BOUNDS: FoldBounds = { min: 180, max: 480, railBelow: 120 }

export const DEFAULT_LAYOUT: Layout = { left: LEFT_DEFAULT, rail: false, right: RIGHT_DEFAULT, tree: TREE_DEFAULT, treeRail: false, focus: false }

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

/** `pointer`: where the edge is dragged to, from the panel's left. `full`: the width to keep for when the rail opens again. */
export function dragLeft(pointer: number, full: number = LEFT_DEFAULT, b: FoldBounds = LEFT_BOUNDS): { width: number; rail: boolean } {
  if (pointer < b.railBelow) return { width: full, rail: true }
  return { width: clamp(Math.round(pointer), b.min, b.max), rail: false }
}

/** A keyboard step on the edge: past the narrowest panel it becomes the rail, and any step outward opens the rail. */
export function stepLeft(layout: Pick<Layout, 'left' | 'rail'>, delta: number, b: FoldBounds = LEFT_BOUNDS): { width: number; rail: boolean } {
  if (layout.rail) return { width: layout.left, rail: delta <= 0 }
  const next = layout.left + delta
  if (next < b.min) return { width: layout.left, rail: true }
  return { width: Math.min(b.max, next), rail: false }
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
    right: num(o.right) ? Math.max(RIGHT_MIN, o.right) : RIGHT_DEFAULT,
    tree: num(o.tree) ? clamp(o.tree, TREE_BOUNDS.min, TREE_BOUNDS.max) : TREE_DEFAULT,
    treeRail: typeof o.treeRail === 'boolean' ? o.treeRail : false,
    focus: typeof o.focus === 'boolean' ? o.focus : false
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
