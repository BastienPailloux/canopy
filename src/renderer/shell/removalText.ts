import type { RemovalRisks } from '../../shared/api'

const s = (n: number): string => (n > 1 ? 's' : '')

function stopped({ sessions, terminals }: RemovalRisks): string | null {
  if (sessions + terminals === 0) return null
  const session = `${sessions} session${s(sessions)} Claude`
  const terminal = terminals > 1 ? `${terminals} terminaux actifs` : `${terminals} terminal actif`
  if (sessions > 0 && terminals > 0) return `${session} et ${terminal} seront arrêtés.`
  if (sessions > 0) return `${session} ${sessions > 1 ? 'seront arrêtées' : 'sera arrêtée'}.`
  return `${terminal} ${terminals > 1 ? 'seront arrêtés' : 'sera arrêté'}.`
}

/** What removing the worktree costs. Commits are not part of it: they stay on the branch. */
export function removalWarnings(r: RemovalRisks, branch: string): string[] {
  const out: string[] = []
  if (r.dirty > 0) out.push(`${r.dirty} fichier${s(r.dirty)} non commité${s(r.dirty)} ${r.dirty > 1 ? 'seront perdus' : 'sera perdu'}.`)
  if (r.unpushed > 0) {
    out.push(`${r.unpushed} commit${s(r.unpushed)} non poussé${s(r.unpushed)} ${r.unpushed > 1 ? 'restent' : 'reste'} sur la branche ${branch}, sans être sur le remote.`)
  }
  const ending = stopped(r)
  return ending ? [...out, ending] : out
}
