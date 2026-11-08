import { draftCount, onDraftsChange } from './code/drafts'
import { composerDraftCount, useSessions } from './sessions/sessionStore'
import { onSaversChange, unsavedTickets } from './tickets/editorSave'

/** Keeps the main process told of what quitting would lose: it asks the question, and only the page knows. */
export function connectUnsaved(): () => void {
  let sent = ''
  const report = (): void => {
    const unsaved = { buffers: draftCount(), drafts: composerDraftCount(), tickets: unsavedTickets() }
    const key = `${unsaved.buffers}:${unsaved.drafts}:${unsaved.tickets}`
    if (key === sent) return
    sent = key
    void window.canopy.reportUnsaved(unsaved).catch(() => { sent = '' })
  }
  report()
  const offDrafts = onDraftsChange(report)
  const offSessions = useSessions.subscribe(report)
  const offTickets = onSaversChange(report)
  return () => { offDrafts(); offSessions(); offTickets() }
}
