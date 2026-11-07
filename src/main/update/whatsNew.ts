import type { ReleaseNotes } from '../../shared/update'

/** X.Y.Z as numbers, or null for anything else (such a version in the history is ignored). */
function parse(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const compare = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * The notes of versions after `lastSeen` up to `current`, newest first.
 * A fresh install (no `lastSeen`) has nothing to catch up on.
 */
export function notesToShow(history: ReleaseNotes[], current: string, lastSeen: string | undefined): ReleaseNotes[] {
  const cur = parse(current)
  const seen = parse(lastSeen)
  if (!cur || !seen) return []
  return history
    .flatMap((n) => { const v = parse(n.version); return v ? [{ n, v }] : [] })
    .filter(({ v }) => compare(v, seen) > 0 && compare(v, cur) <= 0)
    .sort((a, b) => compare(b.v, a.v))
    .map(({ n }) => n)
}
