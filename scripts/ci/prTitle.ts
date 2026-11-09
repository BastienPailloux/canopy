import { parseCommit } from '../release/versioning.ts'

/** Types accepted by the versioning (see CLAUDE.md, « Conventional Commits »). */
export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'chore', 'build', 'ci', 'style']

/**
 * PRs are squash-merged, so their title becomes the commit read by the release versioning.
 * Returns the reason the title is refused, or null when it is valid.
 */
export function checkPrTitle(title: string): string | null {
  const parsed = parseCommit({ subject: title, body: '' })
  if (!parsed) return `Le titre doit être un Conventional Commit : « <type>(<scope>): <description> ».`
  if (!TYPES.includes(parsed.type)) return `Type « ${parsed.type} » inconnu. Types acceptés : ${TYPES.join(', ')}.`
  const scope = /^\w+\(([^)]*)\)/.exec(title)?.[1]
  if (scope === '') return 'Le scope vide « () » est interdit : le retirer ou le remplir.'
  if (scope !== undefined && !/^[a-z0-9-]+$/.test(scope)) return `Le scope « ${scope} » doit être en minuscules.`
  if (/^\p{Lu}/u.test(parsed.description)) return 'La description doit commencer par une minuscule.'
  if (parsed.description.endsWith('.')) return 'La description ne doit pas finir par un point final.'
  return null
}
