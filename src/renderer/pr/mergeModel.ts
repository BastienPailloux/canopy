import type { PrCheck, PrDetail } from '../../shared/pr'

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
