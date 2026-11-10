import type { LinearLink } from '../../shared/linear'
import { isCopilot, type MergeMethod, type PrCheck, type PrDetail, type PrOptions, type PrReviewer } from '../../shared/pr'
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

/**
 * The « Demander une review » picker: GitHub's suggestions and teams, the collaborators, then Copilot, each once,
 * minus who is already waited on, filtered by `query`.
 */
export function reviewerChoices(options: Pick<PrOptions, 'suggested' | 'assignable'>, current: PrReviewer[], query: string): PrOptions['suggested'] {
  const waited = current.filter((r) => r.status === 'pending').map((r) => r.login)
  const seen = new Set<string>()
  const all = [
    ...options.suggested,
    ...options.assignable.map((login) => ({ login, kind: 'user' as const, hint: 'Collaborateur' })),
    COPILOT
  ].filter((s) => {
    const key = isCopilot(s.login) ? COPILOT.login : s.login.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const isWaited = (login: string): boolean =>
    waited.some((w) => (isCopilot(login) ? isCopilot(w) : w.toLowerCase() === login.toLowerCase()))
  const q = query.trim().toLowerCase()
  return all.filter((s) => !isWaited(s.login) && (!q || s.login.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q)))
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

export type GateId = 'draft' | 'review' | 'threads' | 'checks' | 'branch'
export type GateAction = 'ready' | 'showConversation' | 'fixChecks' | 'updateBranch'
export interface MergeGate {
  id: GateId
  /** 'wait': GitHub or the CI is still at it. */
  ok: boolean | 'wait'
  detail: string
  /** The merge button stays off while one blocks; a gate the repo does not enforce only informs. */
  blocking: boolean
  action?: GateAction
}

/** `n word`, with an `s` past one. */
export const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`

/** An IPC rejection's message without Electron's « Error invoking remote method » prefix. */
export const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

function reviewGate(pr: PrDetail): Omit<MergeGate, 'blocking'> {
  const approved = pr.reviewers.filter((r) => r.status === 'approved').length
  const pending = pr.reviewers.filter((r) => r.status === 'pending').length
  const waiting = pending > 0 ? ` · ${plural(pending, 'review')} en attente` : ''
  switch (pr.reviewDecision) {
    case 'CHANGES_REQUESTED': {
      const who = pr.reviewers.filter((r) => r.status === 'changes').map((r) => r.login)
      return { id: 'review', ok: false, detail: `Changements demandés${who.length ? ` par ${who.join(', ')}` : ''}${waiting}` }
    }
    case 'REVIEW_REQUIRED': return { id: 'review', ok: false, detail: `Review requise · ${plural(approved, 'approbation')}${waiting}` }
    case 'APPROVED': return { id: 'review', ok: true, detail: `${plural(approved, 'approbation')}${waiting}` }
    default: return { id: 'review', ok: true, detail: approved > 0 ? `${plural(approved, 'approbation')}${waiting}` : `Aucune review requise${waiting}` }
  }
}

function branchGate(pr: PrDetail): Omit<MergeGate, 'blocking'> {
  switch (pr.mergeStateStatus) {
    case 'DIRTY': return { id: 'branch', ok: false, detail: `Conflits avec ${pr.base} à résoudre` }
    case 'BEHIND': return { id: 'branch', ok: 'wait', detail: `En retard sur ${pr.base}`, action: 'updateBranch' }
    case 'UNKNOWN': return { id: 'branch', ok: 'wait', detail: 'GitHub calcule encore l\'état de la branche' }
    default: return { id: 'branch', ok: true, detail: `À jour avec ${pr.base}, aucun conflit` }
  }
}

/** Nothing blocks in these: GitHub would merge now. UNSTABLE: a failing check the repo does not require. */
const MERGEABLE = new Set<PrDetail['mergeStateStatus']>(['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'UNKNOWN'])

/**
 * The merge panel's conditions. Whether one blocks follows GitHub's `mergeStateStatus`, which knows the branch
 * protections: BEHIND and DIRTY block on the branch, BLOCKED on the review and the checks, and on unresolved threads
 * only when nothing else explains it. UNKNOWN (still computing) blocks nothing: `gh` refuses a merge GitHub would not do.
 */
export function mergeGates(pr: PrDetail): MergeGate[] {
  const status = pr.mergeStateStatus
  const openThreads = tabCounts(pr).openThreads
  const failed = pr.checks.some((c) => c.outcome === 'failure')
  const pending = pr.checks.some((c) => c.outcome === 'pending')
  const gates: Omit<MergeGate, 'blocking'>[] = [
    reviewGate(pr),
    openThreads > 0
      ? { id: 'threads', ok: false, detail: `${plural(openThreads, 'conversation')} non résolue${openThreads > 1 ? 's' : ''}`, action: 'showConversation' }
      : { id: 'threads', ok: true, detail: 'Toutes les conversations sont résolues' },
    {
      id: 'checks', ok: failed ? false : pending ? 'wait' : true,
      detail: pr.checks.length === 0 ? 'Aucun check' : checksSummary(pr.checks),
      ...(failed ? { action: 'fixChecks' as const } : {})
    },
    branchGate(pr)
  ]
  if (pr.state === 'draft') gates.unshift({ id: 'draft', ok: false, detail: 'Marque la PR prête pour review avant de merger', action: 'ready' })
  const othersOff = gates.some((g) => (g.id === 'review' || g.id === 'checks') && g.ok !== true)
  const blocks = (g: Omit<MergeGate, 'blocking'>): boolean => {
    if (g.ok === true) return false
    // GitHub never merges a draft.
    if (g.id === 'draft') return true
    if (MERGEABLE.has(status)) return false
    if (g.id === 'branch') return status === 'BEHIND' || status === 'DIRTY'
    if (status !== 'BLOCKED') return false
    return g.id === 'threads' ? !othersOff : true
  }
  return gates.map((g) => ({ ...g, blocking: blocks(g) }))
}

/** Squash when the repo allows it, else the first method it allows. */
export function defaultMethod(pr: PrDetail): MergeMethod {
  return pr.repo.methods.includes('squash') ? 'squash' : (pr.repo.methods[0] ?? 'squash')
}

/** The commit subject GitHub would offer: the PR title and its number. */
export const defaultSubject = (pr: PrDetail): string => `${pr.title} (#${pr.number})`

/** The squash body GitHub would offer: one line per commit. */
export const defaultBody = (pr: PrDetail): string => pr.commits.map((c) => `* ${c.message.split('\n')[0]}`).join('\n')

/** The release reads the merged subject: only a Conventional Commit counts (`scripts/release/versioning.ts`). */
export const isConventional = (subject: string): boolean =>
  /^(feat|fix|perf|refactor|test|docs|chore|build|ci|style)(\([a-z0-9-]+\))?!?: \S/.test(subject)

export const METHODS: Record<MergeMethod, { label: string; button: string; hint: (pr: PrDetail) => string }> = {
  squash: { label: 'Squash', button: 'Squash et merger', hint: (pr) => `Un seul commit sur ${pr.base}, titre de la PR comme message` },
  merge: { label: 'Commit de merge', button: 'Merger', hint: (pr) => `Conserve ${plural(pr.commits.length, 'commit')} + un commit de merge` },
  rebase: { label: 'Rebase', button: 'Rebase et merger', hint: (pr) => `Rejoue les commits sur ${pr.base}, historique linéaire` }
}

/** The first line of the « PR mergée » detail: how it went in. */
export function mergedHow(method: MergeMethod, commits: number): string {
  if (method === 'squash') return 'Squash en 1 commit'
  if (method === 'rebase') return `Rebase de ${plural(commits, 'commit')}`
  return 'Commit de merge'
}

/**
 * The line beside the merge button. BLOCKED with no gate explaining it: a protection rule Canopy cannot see (signed
 * commits, a required check not reported yet…) still holds the merge.
 */
export function mergeStatus(pr: PrDetail): string {
  if (pr.autoMerge) return 'Auto-merge activé : mergera dès que tout est vert'
  if (mergeGates(pr).some((g) => g.blocking)) return 'Merge bloqué tant que les points ci-dessus ne sont pas réglés'
  if (pr.mergeStateStatus === 'BLOCKED') return 'GitHub bloque encore le merge (règles de protection de la branche)'
  return 'Prêt à merger'
}
