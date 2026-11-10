import type { CanopyApi } from '../../shared/api'
import type { CleanupStep, PrDetail } from '../../shared/pr'
import type { linkedTicket } from './mergeModel'

export interface AfterMergeDeps {
  api: Pick<CanopyApi, 'linearIssue' | 'linearTeamOptions' | 'linearSave' | 'patchTicket' | 'prCleanup' | 'prDeleteLocalBranch'>
  /** Shows the removal dialog of the worktree at `path`, with its risks: true once removed, false when cancelled. */
  confirmRemoval: (repo: string, path: string) => Promise<boolean>
}

export interface AfterMergeInput {
  /** The worktree of the PR's branch. */
  cwd: string
  /** Its main checkout: where tickets live and worktrees are removed from. */
  repo: string
  isMain: boolean
  /** A `PrDetail` from the tab; an auto-merge passes what main said GitHub merged. */
  pr: Pick<PrDetail, 'number' | 'head' | 'headOid'>
  /** « Supprimer la branche distante et le worktree après le merge » was checked. */
  cleanup: boolean
  ticket: ReturnType<typeof linkedTicket>
}

const messageOf = (e: unknown): string =>
  (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`

/** Moves the linked ticket to Done: a Linear issue by its status alone (never its description), a local one by its file. */
async function ticketDone(t: NonNullable<AfterMergeInput['ticket']>, repo: string, api: AfterMergeDeps['api']): Promise<string> {
  try {
    if (t.source === 'local') {
      await api.patchTicket(repo, t.id, { status: 'done' })
      return `${t.id} passé en Done`
    }
    const issue = await api.linearIssue(t.id)
    if (issue.status.type === 'completed') return `${t.id} déjà en Done`
    const done = (await api.linearTeamOptions(issue.team.id)).statuses.find((s) => s.type === 'completed')
    if (!done) return `${t.id} non passé en Done : aucun statut terminé dans l'équipe ${issue.team.name}`
    const saved = await api.linearSave(t.id, { statusId: done.id })
    return saved.kind === 'pending' ? `${t.id} passera en Done dès que Linear répondra` : `${t.id} passé en Done`
  } catch (e) {
    return `${t.id} non passé en Done : ${messageOf(e)}`
  }
}

const DONE: Partial<Record<CleanupStep['step'], string>> = {
  remote: 'Branche distante supprimée', local: 'Branche locale supprimée', update: 'Branche de base mise à jour'
}
const FAILED: Record<CleanupStep['step'], string> = {
  check: 'Nettoyage non fait', remote: 'Branche distante conservée', switch: 'Bascule impossible', local: 'Branche locale conservée', update: 'Base non mise à jour'
}

/** One line per step; `switchedTo`: the branch the worktree is now on. */
function stepLines(steps: CleanupStep[], switchedTo?: string): string[] {
  return steps.flatMap((s) => {
    if (!s.ok) {
      const prefix = FAILED[s.step]
      // Main's messages for these are whole sentences already.
      if (!s.message) return [prefix]
      return [s.step === 'local' || s.step === 'check' || s.message.startsWith(prefix) ? s.message : `${prefix} : ${s.message}`]
    }
    const done = s.step === 'switch' ? (switchedTo ? `Worktree basculé sur ${switchedTo}` : undefined) : DONE[s.step]
    return [done, s.message].filter((l): l is string => !!l)
  })
}

/**
 * What follows a merge started from the tab: the linked ticket goes to Done, then, box checked, the cleanup of §10 runs
 * in main. With no branch to go back to, the worktree's removal dialog opens (never for the main checkout) and the
 * local branch goes only once the worktree is removed. Returns the lines of the « PR mergée » detail.
 */
export async function runAfterMerge(o: AfterMergeInput, deps: AfterMergeDeps): Promise<string[]> {
  const lines: string[] = []
  if (o.ticket) lines.push(await ticketDone(o.ticket, o.repo, deps.api))
  if (!o.cleanup) return [...lines, 'Branche et worktree conservés']

  let outcome
  try {
    outcome = await deps.api.prCleanup(o.cwd, { number: o.pr.number, branch: o.pr.head, headOid: o.pr.headOid })
  } catch (e) {
    return [...lines, `Nettoyage impossible : ${messageOf(e)}`]
  }
  switch (outcome.kind) {
    case 'dirty':
      if (outcome.setAside) {
        const files = outcome.files > 0 ? `${plural(outcome.files, 'fichier')} non commité${outcome.files > 1 ? 's' : ''} et des` : 'Des'
        return [...lines, `${files} modifications mises de côté pour cette branche attendent : nettoyage local non fait`]
      }
      return [...lines, `${plural(outcome.files, 'fichier')} non commité${outcome.files > 1 ? 's' : ''} : nettoyage local non fait`]
    case 'switched':
      return [...lines, ...stepLines(outcome.steps, outcome.branch)]
    case 'failed':
      return [...lines, ...stepLines(outcome.steps)]
    case 'proposeRemoval': {
      lines.push(...stepLines(outcome.steps))
      // Main never proposes it for the main checkout; this guards it all the same.
      if (o.isMain) return [...lines, 'Le checkout principal est conservé']
      let removed: boolean
      try {
        removed = await deps.confirmRemoval(o.repo, o.cwd)
      } catch (e) {
        return [...lines, `Worktree conservé : ${messageOf(e)}`]
      }
      if (!removed) return [...lines, 'Worktree et branche locale conservés']
      lines.push('Worktree supprimé')
      const step = await deps.api.prDeleteLocalBranch(o.repo, o.pr.head)
        .catch((e: unknown): CleanupStep => ({ step: 'local', ok: false, message: messageOf(e) }))
      return [...lines, ...stepLines([step])]
    }
  }
}
