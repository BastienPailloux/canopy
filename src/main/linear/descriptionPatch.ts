/**
 * Description edits as Linear `save_issue` `patch` ops (see tests/fixtures/linear/README.md).
 * Linear matches anchors as plain substrings, exactly once; ops are applied in order and atomically.
 * Anchors are always whole lines of Linear's own text, and include the neighbouring newlines when there are
 * some, so a substring match in an interior position is a whole-line match.
 */
export type PatchOp =
  | { op: 'replace'; old_string: string; new_string: string }
  | { op: 'insert_before' | 'insert_after'; anchor: string; text: string }
  /** Only for an empty base, which has nothing to anchor on. */
  | { op: 'append'; text: string }

const count = (s: string, sub: string): number => (sub === '' ? 0 : s.split(sub).length - 1)
const unique = (s: string, sub: string): boolean => count(s, sub) === 1

/** Start of the line holding position `i`. */
const lineStart = (s: string, i: number): number => s.lastIndexOf('\n', i - 1) + 1
/** End of the line holding position `i` (index of its `\n`, or the length). */
const lineEnd = (s: string, i: number): number => {
  const n = s.indexOf('\n', i)
  return n === -1 ? s.length : n
}
/** One more line before `a` (which is 0, a line start or a `\n`): back to the previous `\n`, or 0. */
const widenBack = (s: string, a: number): number => (a <= 0 ? 0 : Math.max(0, s.lastIndexOf('\n', a - 1)))
/** One more line after `b` (the length, or just after a line's content or its `\n`): through the next `\n`, or the length. */
const widenForward = (s: string, b: number): number => {
  if (b >= s.length) return s.length
  const n = s.indexOf('\n', s[b] === '\n' ? b + 1 : b)
  return n === -1 ? s.length : n + 1
}

/** Common prefix and suffix of `base` and `mine`: the changed middle is `base[p, e)` -> `mine[p, me)`. */
function middle(base: string, mine: string): { p: number; e: number; me: number } {
  let p = 0
  const max = Math.min(base.length, mine.length)
  while (p < max && base[p] === mine[p]) p++
  let s = 0
  while (s < max - p && base[base.length - 1 - s] === mine[mine.length - 1 - s]) s++
  return { p, e: base.length - s, me: mine.length - s }
}

/** One op turning `base` into `mine`, anchored on whole lines unique in `base`; `[]` when equal. */
export function diffToPatch(base: string, mine: string): PatchOp[] {
  if (base === mine) return []
  if (base === '') return [{ op: 'append', text: mine }]
  const { p, e, me } = middle(base, mine)

  if (p === e && p === base.length) {
    // appended at the very end: insert after the last line(s)
    let a = lineStart(base, p)
    if (a > 0) a -= 1
    while (!unique(base, base.slice(a, p)) && a > 0) a = widenBack(base, a)
    return [{ op: 'insert_after', anchor: base.slice(a, p), text: mine.slice(p, me) }]
  }
  if (p === e && p === 0) {
    // prepended at the very start: insert before the first line(s)
    let b = widenForward(base, 0)
    while (!unique(base, base.slice(0, b)) && b < base.length) b = widenForward(base, b)
    return [{ op: 'insert_before', anchor: base.slice(0, b), text: mine.slice(0, me) }]
  }

  let a = lineStart(base, p)
  let b = e > p && base[e - 1] === '\n' ? e : lineEnd(base, e)
  if (a > 0) a -= 1
  if (b < base.length && base[b] === '\n' && base[b - 1] !== '\n') b += 1
  let back = true
  while (!unique(base, base.slice(a, b)) && (a > 0 || b < base.length)) {
    if ((back && a > 0) || b >= base.length) a = widenBack(base, a)
    else b = widenForward(base, b)
    back = !back
  }
  return [{ op: 'replace', old_string: base.slice(a, b), new_string: mine.slice(a, me + (b - e)) }]
}

const anchorOf = (op: PatchOp): string | null => (op.op === 'replace' ? op.old_string : op.op === 'append' ? null : op.anchor)

/** `anchor` occurs exactly once in `text`, on line boundaries (Linear only checks the substring). */
function anchoredOnce(text: string, anchor: string): boolean {
  if (!unique(text, anchor)) return false
  const i = text.indexOf(anchor)
  const j = i + anchor.length
  const startOk = i === 0 || text[i - 1] === '\n' || anchor.startsWith('\n')
  const endOk = j === text.length || text[j] === '\n' || anchor.endsWith('\n')
  return startOk && endOk
}

/**
 * Bastien's edit (`base` -> `mine`) replayed on Linear's current text `remote`. Clean when `remote` is still `base`,
 * already holds `mine`, or every anchor of the edit is still there exactly once as whole lines (a colleague edited
 * elsewhere). Otherwise a conflict: the same passage changed on both sides.
 */
export function rebase(base: string, mine: string, remote: string): { kind: 'clean'; ops: PatchOp[] } | { kind: 'conflict'; remote: string } {
  const ops = diffToPatch(base, mine)
  if (remote === base) return { kind: 'clean', ops }
  if (remote === mine) return { kind: 'clean', ops: [] }
  for (const op of ops) {
    const anchor = anchorOf(op)
    if (anchor === null || !anchoredOnce(remote, anchor)) return { kind: 'conflict', remote }
  }
  return { kind: 'clean', ops }
}
