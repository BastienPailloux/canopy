import { changedIds } from '../../shared/linear'

/** Events of one burst (a save emits its queue change twice, then the refresh) make one read. */
export const RELOAD_DEBOUNCE_MS = 300

/**
 * What an open Linear editor reads again, debounced. Reading the issue costs several Linear calls (issue, sub-issue
 * and comment pages), so it is read again only when it may have changed in Linear: an event naming no issue
 * (connection), or a list copy newer than the version shown (a colleague, a resend by main). An event naming this
 * issue reads its queue only (local). Its own save answer is already shown: its list copy is not newer, nothing is read.
 */
export function createEditorReload(o: {
  id: string
  /** Reads the issue and the queue. */
  reload: () => void
  /** Reads the queue only. */
  pending: () => void
  /** `updatedAt` of the version shown; null: not loaded yet. */
  knownAt: () => string | null
  delay?: number
}): { event: (payload: unknown) => void; listed: (updatedAt: string | undefined) => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let want: 'pending' | 'reload' | null = null
  let stopped = false

  const schedule = (what: 'pending' | 'reload'): void => {
    if (stopped) return
    if (want !== 'reload') want = what
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const w = want
      want = null
      if (w === 'reload') o.reload()
      else if (w === 'pending') o.pending()
    }, o.delay ?? RELOAD_DEBOUNCE_MS)
  }

  return {
    event(payload) {
      const ids = changedIds(payload)
      if (ids === undefined) schedule('reload')
      else if (ids.includes(o.id)) schedule('pending')
    },
    listed(updatedAt) {
      const known = o.knownAt()
      if (updatedAt === undefined || known === null) return
      if (Date.parse(updatedAt) > Date.parse(known)) schedule('reload')
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
