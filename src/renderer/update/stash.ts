import { create } from 'zustand'
import { allDrafts, setDraft } from '../code/drafts'
import { restoreTabs, stashTabs } from '../sessions/sessionStore'
import type { Stash, StashedBuffer } from '../../shared/update'

/** Files whose unsaved text came back after an update: the user is told which. */
export const useRestoredFiles = create<{ files: StashedBuffer[] }>(() => ({ files: [] }))

export const collectStash = (): Stash => ({ format: 1, buffers: allDrafts(), tabs: stashTabs() })

/** The version stays the one typed over, so that CodeView still notices a file changed on disk. */
export function restoreStash(s: Stash): void {
  for (const b of s.buffers) setDraft(b.cwd, b.path, { text: b.text, version: b.version })
  useRestoredFiles.setState({ files: s.buffers })
  restoreTabs(s.tabs)
}

/** Answers the main process when an update is about to restart the app. */
export function connectUpdateStash(): () => void {
  return window.canopy.on('update:collectStash', () => { window.canopy.submitStash(collectStash()) })
}
