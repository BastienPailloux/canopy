import { create } from 'zustand'
import { DEFAULT_LAYOUT, parseLayout, type Layout } from './panelWidths'

const KEY = 'canopy.panels'

function load(): Layout {
  try { return parseLayout(localStorage.getItem(KEY)) } catch { return DEFAULT_LAYOUT }
}

/** The side panel widths and folds, kept across restarts. */
export const useLayout = create<Layout & { update: (patch: Partial<Layout>) => void }>((set) => ({
  ...load(),
  update: (patch) => set(patch)
}))

useLayout.subscribe(({ left, rail, right, tree, treeRail, focus }) => {
  try { localStorage.setItem(KEY, JSON.stringify({ left, rail, right, tree, treeRail, focus })) } catch { /* not saved: the next start uses the defaults */ }
})
