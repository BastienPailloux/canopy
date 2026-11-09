import { CLAUDE_SIGNATURE, type PrThread } from '../../shared/pr'
import type { TabState } from '../sessions/sessionStore'

/** The thread's Claude button, from the state of the session it started (none: never asked). */
export function claudeThreadLabel(state: TabState | undefined): { label: string; busy: boolean } {
  if (state === 'draft' || state === 'running' || state === 'waiting') return { label: 'Claude traite le retour', busy: true }
  if (state === 'idle' || state === 'stopped') return { label: 'Claude a traité le retour', busy: false }
  return { label: 'Faire corriger par Claude', busy: false }
}

/** `L19–20`, `L20`, or nothing for a thread on the whole file. */
export function lineLabel(t: Pick<PrThread, 'line' | 'startLine'>): string {
  if (t.line === null) return ''
  return t.startLine !== null && t.startLine !== t.line ? `L${t.startLine}–${t.line}` : `L${t.line}`
}

/** A Claude reply without its signature line: the card says who wrote it. */
export function withoutSignature(body: string): string {
  const text = body.trimEnd()
  return text.endsWith(CLAUDE_SIGNATURE) ? text.slice(0, -CLAUDE_SIGNATURE.length).trimEnd() : body
}

export interface HunkRow { n: number | null; kind: 'same' | 'add' | 'del'; text: string }

/** The last `keep` lines of a GitHub diff hunk, numbered on the new side (old side for a deletion). */
export function hunkRows(hunk: string, keep: number): HunkRow[] {
  const lines = hunk.split('\n')
  const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(lines[0] ?? '')
  let oldN = head ? Number(head[1]) : null
  let newN = head ? Number(head[2]) : null
  const rows: HunkRow[] = []
  for (const line of head ? lines.slice(1) : lines) {
    const c = line[0]
    if (c === '+') {
      rows.push({ n: newN, kind: 'add', text: line.slice(1) })
      if (newN !== null) newN++
    } else if (c === '-') {
      rows.push({ n: oldN, kind: 'del', text: line.slice(1) })
      if (oldN !== null) oldN++
    } else {
      rows.push({ n: newN, kind: 'same', text: c === ' ' ? line.slice(1) : line })
      if (newN !== null) newN++
      if (oldN !== null) oldN++
    }
  }
  return rows.slice(-keep)
}
