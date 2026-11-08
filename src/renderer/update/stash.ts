import { useEffect } from 'react'
import { create } from 'zustand'
import { allDrafts, getDraft, onDraftsChange, setDraft, type Draft } from '../code/drafts'
import { restoreTabs, stashTabs } from '../sessions/sessionStore'
import type { Stash, StashedBuffer } from '../../shared/update'
import { flushSavers } from '../tickets/editorSave'

/** Files whose unsaved text came back after an update: the user is told which. */
export const useRestoredFiles = create<{ files: StashedBuffer[] }>(() => ({ files: [] }))

/** The restored files still unsaved: one leaves the list once it is saved or its changes are dropped. */
export const stillUnsaved = (files: StashedBuffer[], draft: (cwd: string, path: string) => Draft | undefined): StashedBuffer[] =>
  files.filter((f) => draft(f.cwd, f.path) !== undefined)

/** The restored files still unsaved, kept up to date: a file saved then edited again does not come back. */
export function useStillUnsaved(): StashedBuffer[] {
  const files = useRestoredFiles((s) => s.files)
  useEffect(() => onDraftsChange(() => {
    const { files } = useRestoredFiles.getState()
    const left = stillUnsaved(files, getDraft)
    if (left.length !== files.length) useRestoredFiles.setState({ files: left })
  }), [])
  return stillUnsaved(files, getDraft)
}

export const collectStash = (): Stash => ({ format: 1, buffers: allDrafts(), tabs: stashTabs() })

/** The version stays the one typed over, so that CodeView still notices a file changed on disk. */
export function restoreStash(s: Stash): void {
  for (const b of s.buffers) setDraft(b.cwd, b.path, { text: b.text, version: b.version })
  useRestoredFiles.setState({ files: s.buffers })
  restoreTabs(s.tabs)
}

/** Answers the main process when an update is about to restart the app, once the ticket edits are written. */
export function connectUpdateStash(): () => void {
  return window.canopy.on('update:collectStash', () => {
    // Bounded: the main process stops waiting for the stash after a few seconds.
    const wait = new Promise((resolve) => setTimeout(resolve, 2000))
    void Promise.race([flushSavers().catch(() => false), wait]).then(() => { window.canopy.submitStash(collectStash()) })
  })
}
