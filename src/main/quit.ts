/** What the page holds and quitting would lose. Only the renderer knows: it reports it. */
/** `tickets`: ticket editors with changes not written yet. */
export interface UnsavedCounts { buffers: number; drafts: number; tickets: number }
/** `linear`: Linear edits queued in main and not sent yet; they are kept on disk and sent at the next launch. */
export interface RunningCounts extends UnsavedCounts { sessions: number; terminals: number; linear: number }

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

export function parseUnsaved(raw: unknown): UnsavedCounts {
  const { buffers, drafts, tickets } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (!isCount(buffers) || !isCount(drafts) || !isCount(tickets)) throw new Error('Compte invalide')
  return { buffers, drafts, tickets }
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

/** What is still running, shared by the quit question and the update one. */
const runningList = ({ sessions, terminals }: RunningCounts): string[] => [
  ...(sessions > 0 ? [plural(sessions, 'session Claude en cours', 'sessions Claude en cours')] : []),
  ...(terminals > 0 ? [plural(terminals, 'terminal actif', 'terminaux actifs')] : [])
]

/** The one question asked at quit, with what is still running and what would be lost. */
export function quitDetail(counts: RunningCounts): string {
  const { buffers, drafts, tickets } = counts
  const running = runningList(counts)
  const lost = [
    ...(buffers > 0 ? [plural(buffers, 'fichier non enregistré', 'fichiers non enregistrés')] : []),
    ...(drafts > 0 ? [plural(drafts, 'brouillon de message', 'brouillons de message')] : []),
    ...(tickets > 0 ? [plural(tickets, 'ticket pas encore enregistré', 'tickets pas encore enregistrés')] : [])
  ]
  const { linear } = counts
  return [
    ...(running.length > 0 ? [`Quitter arrêtera : ${running.join(', ')}.`] : []),
    ...(lost.length > 0 ? [`${buffers + drafts + tickets > 1 ? 'Seront perdus' : 'Sera perdu'} : ${lost.join(', ')}.`] : []),
    ...(linear === 1 ? ['1 modification Linear n’a pas encore été envoyée : elle le sera au prochain lancement.'] : []),
    ...(linear > 1 ? [`${linear} modifications Linear n’ont pas encore été envoyées : elles le seront au prochain lancement.`] : [])
  ].join(' ')
}

/** What an update restart says before it stops things: what stops, and what survives it. */
export function updateDetail(counts: RunningCounts): string {
  const running = runningList(counts)
  return [
    ...(running.length > 0 ? [`Redémarrer arrêtera : ${running.join(', ')}.`] : []),
    'Les fichiers non enregistrés et les brouillons seront conservés.',
    ...(counts.tickets === 1
      ? ['1 ticket pas encore enregistré le sera avant le redémarrage ; en cas d’échec, ses modifications seront perdues.']
      : counts.tickets > 1
        ? [`${counts.tickets} tickets pas encore enregistrés le seront avant le redémarrage ; en cas d’échec, leurs modifications seront perdues.`]
        : [])
  ].join(' ')
}

/**
 * Every way out of the app (⌘Q, closing the window) goes through `request`. Nothing at stake: quits at once.
 * Something running or unsaved: one confirmation, then everything is stopped before quitting. Cancel changes nothing.
 * `finish` is the update restart: it stops everything without asking, then hands over to `then` instead of quitting.
 */
export function createQuitFlow(deps: QuitDeps): {
  request: () => Promise<void>
  finish: (then: () => void) => void
  readonly quitting: boolean
} {
  let quitting = false
  let asking = false
  return {
    get quitting() { return quitting },
    finish(then) {
      if (quitting) return
      quitting = true
      deps.shutdown()
      then()
    },
    async request() {
      if (quitting || asking) return
      const counts = deps.counts()
      if (counts.sessions + counts.terminals + counts.buffers + counts.drafts + counts.tickets + counts.linear > 0) {
        asking = true
        try {
          if (!(await deps.confirm(counts))) return
        } finally {
          asking = false
        }
      }
      // An update restart may have finished everything while the question was open.
      if (quitting) return
      quitting = true
      deps.shutdown()
      deps.quit()
    }
  }
}
