import { CLAUDE_SIGNATURE, type PrCheck, type PrDetail, type PrThread } from '../../shared/pr'
import { fenceFor } from '../fence'

/** The prompts the PR tab's « Claude » actions send, each to a new session. */

type PrRef = Pick<PrDetail, 'number' | 'url' | 'repo'>

const fenced = (text: string, lang = ''): string => {
  const fence = fenceFor(text)
  return `${fence}${lang}\n${text}\n${fence}`
}

const quoted = (body: string): string => body.trimEnd().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')

function location(t: Pick<PrThread, 'path' | 'line' | 'startLine'>): string {
  if (t.line === null) return t.path
  return t.startLine !== null && t.startLine !== t.line ? `${t.path}:${t.startLine}–${t.line}` : `${t.path}:${t.line}`
}

/**
 * « Faire corriger par Claude »: the whole thread, then how to answer it. The reply goes through `gh` under the
 * user's account and ends with `CLAUDE_SIGNATURE`, which is how the tab shows it as Claude's.
 */
export function threadPrompt(pr: PrRef, thread: PrThread): string {
  const [first] = thread.comments
  const author = first?.author.login ?? 'un relecteur'
  const command = `gh api -X POST repos/${pr.repo.owner}/${pr.repo.name}/pulls/${pr.number}/comments/${first?.databaseId}/replies -F body=@-`
  return [
    `Retour de revue de ${author} sur la PR #${pr.number} (${pr.url}), sur \`${location(thread)}\`${thread.outdated ? ' (le code a changé depuis)' : ''}.`,
    '',
    'Extrait du diff :',
    fenced(thread.diffHunk, 'diff'),
    '',
    'Le fil, dans l\'ordre :',
    ...thread.comments.flatMap((c) => ['', `${c.author.login} :`, quoted(c.body)]),
    '',
    'Traite ce retour, ou explique pourquoi ne pas le faire. Puis commite et pousse.',
    '',
    'Quand c\'est fini, réponds dans le fil avec cette commande, en remplaçant la première ligne par ta réponse et en gardant la signature en dernière ligne :',
    '',
    '```sh',
    `${command} <<'CANOPY_REPLY'`,
    'Ta réponse.',
    '',
    CLAUDE_SIGNATURE,
    'CANOPY_REPLY',
    '```',
    '',
    'Ne résous pas la conversation : c\'est moi qui le ferai.'
  ].join('\n')
}

/** « Envoyer à Claude »: the composer's text, with the PR it is about. Nothing goes to GitHub. */
export const commentPrompt = (pr: Pick<PrDetail, 'number' | 'title'>, text: string): string =>
  `À propos de la PR #${pr.number} « ${pr.title} » :\n\n${text}`

/** « Corriger avec Claude »: the failed check's log. The push reruns the CI. */
export const checkPrompt = (pr: Pick<PrDetail, 'number'>, check: PrCheck, log: string, sha: string): string => [
  `Le check « ${check.name} » a échoué sur le commit ${sha} de la PR #${pr.number}.`,
  '',
  'Extrait du log :',
  fenced(log),
  '',
  'Corrige le problème, puis commite et pousse : la CI se relancera d\'elle-même.'
].join('\n')
