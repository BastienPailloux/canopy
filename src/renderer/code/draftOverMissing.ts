import type { FileContent } from '../../shared/api'
import type { Draft } from './drafts'

type Work = FileContent | { kind: 'missing' } | { kind: 'error'; message: string }

/**
 * A draft whose file no longer exists (restored after an update, or deleted meanwhile) stays the user's buffer:
 * it is shown over an empty file instead of the read error. Null when the draft has nothing to say about `work`.
 */
export function keepOverMissing(work: Work, draft: Draft | undefined): { work: FileContent; text: string } | null {
  if (!draft) return null
  const gone = work.kind === 'missing' || (work.kind === 'error' && /ENOENT|no such file/i.test(work.message))
  return gone ? { work: { kind: 'text', content: '', version: draft.version }, text: draft.text } : null
}
