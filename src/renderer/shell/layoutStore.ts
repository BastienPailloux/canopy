import { create } from 'zustand'
import { DEFAULT_LAYOUT, parseLayout, type Layout } from './panelWidths'

const KEY = 'canopy.panels'

function load(): Layout {
  try { return parseLayout(localStorage.getItem(KEY)) } catch { return DEFAULT_LAYOUT }
}

/** The side panel widths, kept across restarts. */
export const useLayout = create<Layout & { update: (patch: Partial<Layout>) => void }>((set) => ({
  ...load(),
  update: (patch) => set(patch)
}))

useLayout.subscribe(({ left, rail, right }) => {
  try { localStorage.setItem(KEY, JSON.stringify({ left, rail, right })) } catch { /* not saved: the next start uses the defaults */ }
})
