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

/** What lives only in the app for the worktree: unsaved editor buffers and unsent messages. */
export interface MemoryRisks { buffers: number; messages: number }

function unsaved({ buffers, messages }: MemoryRisks): string | null {
  if (buffers + messages === 0) return null
  const parts: string[] = []
  if (buffers > 0) parts.push(`${buffers} fichier${s(buffers)} non enregistré${s(buffers)}`)
  if (messages > 0) parts.push(`${messages} brouillon${s(messages)} de message`)
  return `${parts.join(' et ')} ${buffers + messages > 1 ? 'seront perdus' : 'sera perdu'}.`
}

/** What removing the worktree costs. Commits on a branch are not part of it: they stay there. On a detached HEAD (`branch` null), `unpushed` counts the commits no branch reaches, which are lost. */
export function removalWarnings(r: RemovalRisks, branch: string | null, memory: MemoryRisks = { buffers: 0, messages: 0 }): string[] {
  const out: string[] = []
  if (r.dirty > 0) out.push(`${r.dirty} fichier${s(r.dirty)} non commité${s(r.dirty)} ${r.dirty > 1 ? 'seront perdus' : 'sera perdu'}.`)
  const inMemory = unsaved(memory)
  if (inMemory) out.push(inMemory)
  if (r.unpushed > 0 && branch === null) {
    out.push(`${r.unpushed} commit${s(r.unpushed)} ${r.unpushed > 1 ? 'ne sont' : "n'est"} sur aucune branche et ${r.unpushed > 1 ? 'seront perdus' : 'sera perdu'}. Crée d'abord une branche pour ${r.unpushed > 1 ? 'les' : 'le'} garder.`)
  } else if (r.unpushed > 0) {
    out.push(`${r.unpushed} commit${s(r.unpushed)} non poussé${s(r.unpushed)} ${r.unpushed > 1 ? 'restent' : 'reste'} sur la branche ${branch}, sans être sur le remote.`)
  }
  const ending = stopped(r)
  return ending ? [...out, ending] : out
}
