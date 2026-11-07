export interface RunningCounts { sessions: number; terminals: number }

export interface QuitDeps {
  counts: () => RunningCounts
  /** Asks once; resolves true to quit. */
  confirm: (counts: RunningCounts) => Promise<boolean>
  /** Stops sessions, terminals and language servers. */
  shutdown: () => void
  quit: () => void
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

/** The one question asked at quit, with what is still running. */
export function quitDetail({ sessions, terminals }: RunningCounts): string {
  const parts = [
    ...(sessions > 0 ? [plural(sessions, 'session Claude en cours', 'sessions Claude en cours')] : []),
    ...(terminals > 0 ? [plural(terminals, 'terminal actif', 'terminaux actifs')] : [])
  ]
  return `Quitter arrêtera : ${parts.join(', ')}.`
}

/**
 * Every way out of the app (⌘Q, closing the window) goes through `request`. Nothing running: quits at once.
 * Something running: one confirmation, then everything is stopped before quitting. Cancel changes nothing.
 */
export function createQuitFlow(deps: QuitDeps): { request: () => Promise<void>; readonly quitting: boolean } {
  let quitting = false
  let asking = false
  return {
    get quitting() { return quitting },
    async request() {
      if (quitting || asking) return
      const counts = deps.counts()
      if (counts.sessions + counts.terminals > 0) {
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
