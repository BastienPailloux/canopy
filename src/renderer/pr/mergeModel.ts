import type { LinearLink } from '../../shared/linear'
import type { PrCheck, PrDetail, PrOptions, PrReviewer } from '../../shared/pr'
import type { TicketListEntry } from '../../shared/tickets'

export interface TabCounts {
  openThreads: number
  commits: number
  checks: { ok: number; total: number }
  files: number
  /** The sub-tab badge turns red: a thread still open, a check failed. */
  alert: { conv: boolean; checks: boolean }
}

/** What the sub-tabs and the header's « PR » badge count. */
export function tabCounts(pr: PrDetail): TabCounts {
  const openThreads = pr.timeline.filter((i) => i.kind === 'thread' && !i.thread.resolved).length
  // GitHub shows a skipped or neutral check as not failing: it counts as passed.
  const ok = pr.checks.filter((c) => c.outcome === 'success' || c.outcome === 'neutral').length
  return {
    openThreads,
    commits: pr.commits.length,
    checks: { ok, total: pr.checks.length },
    files: pr.files.length,
    alert: { conv: openThreads > 0, checks: pr.checks.some((c) => c.outcome === 'failure') }
  }
}

/** The Checks tab's headline: passed (neutral counts), failing, or still running. */
export function checksSummary(checks: PrCheck[]): string {
  const ok = checks.filter((c) => c.outcome === 'success' || c.outcome === 'neutral').length
  const failed = checks.filter((c) => c.outcome === 'failure').length
  if (failed > 0) return `${failed} check${failed > 1 ? 's' : ''} en échec · ${ok}/${checks.length} réussis`
  if (ok < checks.length) return `Checks en cours · ${ok}/${checks.length} réussis`
  return 'Tous les checks passent'
}

/** The ticket launched on `head`: the Linear link first, else a local ticket whose branch it is. */
export function linkedTicket(
  head: string,
  linear: Record<string, LinearLink>,
  tickets: TicketListEntry[]
): { source: 'linear' | 'local'; id: string; title?: string } | null {
  const id = Object.entries(linear).find(([, l]) => l.branch === head)?.[0]
  if (id) return { source: 'linear', id }
  for (const e of tickets) if (e.kind === 'ticket' && e.ticket.branch === head) return { source: 'local', id: e.ticket.id, title: e.ticket.title }
  return null
}

/** GitHub's list does not carry Copilot: the picker adds it, as a reviewer (never as an assignee). */
const COPILOT: PrOptions['suggested'][number] = { login: 'copilot', kind: 'bot', hint: 'Relecture par Copilot' }

/** The « Demander une review » picker: suggestions plus Copilot, minus who is already waited on, filtered by `query`. */
export function reviewerChoices(suggested: PrOptions['suggested'], current: PrReviewer[], query: string): PrOptions['suggested'] {
  const waited = new Set(current.filter((r) => r.status === 'pending').map((r) => r.login.toLowerCase()))
  const all = suggested.some((s) => s.login.toLowerCase() === COPILOT.login) ? suggested : [...suggested, COPILOT]
  const q = query.trim().toLowerCase()
  return all.filter((s) => !waited.has(s.login.toLowerCase()) && (!q || s.login.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q)))
}

export const REVIEWER_STATUS: Record<PrReviewer['status'], string> = {
  approved: 'Approuvé', commented: 'A commenté', changes: 'Changements demandés', pending: 'En attente'
}

/** The « Session Claude » line: the state of the worktree's active session tab, none when it has no session yet. */
export function sessionText(state: string | undefined): string {
  switch (state) {
    case 'running': return 'Claude travaille'
    case 'waiting': return 'Claude attend ta réponse'
    case 'idle': return 'Session au repos'
    case 'stopped': return 'Session arrêtée'
    case 'error': return 'Session en erreur'
    default: return 'Aucune session en cours'
  }
}
