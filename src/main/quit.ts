/** What the page holds and quitting would lose. Only the renderer knows: it reports it. */
export interface UnsavedCounts { buffers: number; drafts: number }
export interface RunningCounts extends UnsavedCounts { sessions: number; terminals: number }

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

export function parseUnsaved(raw: unknown): UnsavedCounts {
  const { buffers, drafts } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (!isCount(buffers) || !isCount(drafts)) throw new Error('Compte invalide')
  return { buffers, drafts }
}

export interface QuitDeps {
  counts: () => RunningCounts
  /** Asks once; resolves true to quit. */
  confirm: (counts: RunningCounts) => Promise<boolean>
  /** Stops sessions, terminals and language servers. */
  shutdown: () => void
  quit: () => void
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

/** The one question asked at quit, with what is still running and what would be lost. */
export function quitDetail({ sessions, terminals, buffers, drafts }: RunningCounts): string {
  const running = [
    ...(sessions > 0 ? [plural(sessions, 'session Claude en cours', 'sessions Claude en cours')] : []),
    ...(terminals > 0 ? [plural(terminals, 'terminal actif', 'terminaux actifs')] : [])
  ]
  const lost = [
    ...(buffers > 0 ? [plural(buffers, 'fichier non enregistré', 'fichiers non enregistrés')] : []),
    ...(drafts > 0 ? [plural(drafts, 'brouillon de message', 'brouillons de message')] : [])
  ]
  return [
    ...(running.length > 0 ? [`Quitter arrêtera : ${running.join(', ')}.`] : []),
    ...(lost.length > 0 ? [`${buffers + drafts > 1 ? 'Seront perdus' : 'Sera perdu'} : ${lost.join(', ')}.`] : [])
  ].join(' ')
}

/**
 * Every way out of the app (⌘Q, closing the window) goes through `request`. Nothing at stake: quits at once.
 * Something running or unsaved: one confirmation, then everything is stopped before quitting. Cancel changes nothing.
 */
export function createQuitFlow(deps: QuitDeps): { request: () => Promise<void>; readonly quitting: boolean } {
  let quitting = false
  let asking = false
  return {
    get quitting() { return quitting },
    async request() {
      if (quitting || asking) return
      const counts = deps.counts()
      if (counts.sessions + counts.terminals + counts.buffers + counts.drafts > 0) {
        asking = true
        try {
          if (!(await deps.confirm(counts))) return
        } finally {
          asking = false
        }
      }
      quitting = true
      deps.shutdown()
      deps.quit()
    }
  }
}
