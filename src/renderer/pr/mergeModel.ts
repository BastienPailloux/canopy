import type { PrDetail } from '../../shared/pr'

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
  const ok = pr.checks.filter((c) => c.outcome === 'success').length
  return {
    openThreads,
    commits: pr.commits.length,
    checks: { ok, total: pr.checks.length },
    files: pr.files.length,
    alert: { conv: openThreads > 0, checks: pr.checks.some((c) => c.outcome === 'failure') }
  }
}
