export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

/** Above this many table cells, the changed middle is shown as replaced rather than compared. */
const MAX_CELLS = 1_000_000

const splitLines = (s: string): string[] => (s === '' ? [] : s.split('\n'))

/** Longest common subsequence of two line lists, as a diff. */
function compare(a: string[], b: string[]): DiffLine[] {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (j === b.length || (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  return out
}

/** Line diff of the two sides of an Edit or Write. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++

  const midA = a.slice(start, a.length - end)
  const midB = b.slice(start, b.length - end)
  const middle = midA.length * midB.length > MAX_CELLS
    ? [...midA.map((text): DiffLine => ({ kind: 'del', text })), ...midB.map((text): DiffLine => ({ kind: 'add', text }))]
    : compare(midA, midB)
  const same = (text: string): DiffLine => ({ kind: 'same', text })
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(a.length - end).map(same)]
}
