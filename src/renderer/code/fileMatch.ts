/** Kinds of match, best first. A query holding a slash can only reach the path ones. */
const enum Tier { Name = 6, NamePrefix = 5, NameSubstring = 4, PathSubstring = 3, NameLetters = 2, PathLetters = 1 }

const BOUNDARY = 8
const CONSECUTIVE = 6
const GAP = 1
const NONE = -Infinity
let rowA = new Float64Array(256)
let rowB = new Float64Array(256)

/** True when `text[i]` starts a word: the start, after a separator, or an uppercase after a lowercase. */
function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  if ('/-_. '.includes(prev)) return true
  const c = text[i]
  return c !== c.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase()
}

/**
 * Best score of `q` (lowercase) as letters in order in `text`, or null when they are not all there.
 * Letters starting words and letters next to each other score; gaps between letters cost.
 */
function lettersScore(text: string, lower: string, q: string): number | null {
  const n = lower.length
  // prev[j]: best score with the previous letter of `q` at j. Rows are reused: this runs for every path, at each keystroke.
  if (rowA.length < n) { rowA = new Float64Array(n * 2); rowB = new Float64Array(n * 2) }
  let prev = rowA
  let row = rowB
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    // Best of prev[k] - GAP * (j - k - 1) for k < j - 1, carried along j.
    let carried = NONE
    for (let j = 0; j < n; j++) {
      if (j >= 2) carried = Math.max(carried - GAP, prev[j - 2] - GAP)
      row[j] = NONE
      if (lower[j] !== c) continue
      const own = 1 + (isBoundary(text, j) ? BOUNDARY : 0)
      if (i === 0) {
        row[j] = own
        continue
      }
      const best = Math.max(j >= 1 ? prev[j - 1] + CONSECUTIVE : NONE, carried)
      if (best !== NONE) row[j] = best + own
    }
    const t = prev
    prev = row
    row = t
  }
  let best = NONE
  for (let j = 0; j < n; j++) if (prev[j] > best) best = prev[j]
  return best === NONE ? null : best
}

/** True when the characters of `q` appear in order in `lower`: the cheap test that rules most paths out. */
function hasLetters(lower: string, q: string): boolean {
  let at = 0
  for (let i = 0; i < q.length; i++) {
    at = lower.indexOf(q[i], at)
    if (at < 0) return false
    at++
  }
  return true
}

/** [tier, quality within the tier], or null when `path` does not match `q` (lowercase, not empty). */
function score(path: string, lower: string, q: string): [Tier, number] | null {
  if (!hasLetters(lower, q)) return null
  const slash = path.lastIndexOf('/') + 1
  const name = path.slice(slash)
  const lowerName = lower.slice(slash)
  // Only the last extension goes: `search.test.ts` is not named `search`, and `.env` keeps its name.
  const dot = lowerName.lastIndexOf('.')
  if (lowerName === q || (dot > 0 && lowerName.slice(0, dot) === q)) return [Tier.Name, 0]
  if (lowerName.startsWith(q)) return [Tier.NamePrefix, 0]
  const inName = lowerName.indexOf(q)
  if (inName >= 0) return [Tier.NameSubstring, isBoundary(name, inName) ? 1 : 0]
  const inPath = lower.indexOf(q)
  if (inPath >= 0) return [Tier.PathSubstring, isBoundary(path, inPath) ? 1 : 0]
  const letters = lettersScore(name, lowerName, q)
  if (letters !== null) return [Tier.NameLetters, letters]
  const all = lettersScore(path, lower, q)
  return all === null ? null : [Tier.PathLetters, all]
}

/**
 * `text` in lowercase, one unit for one unit: the indexes found in it must hold in `text`.
 * A letter whose lowercase is longer (`İ` gives `i` and a combining dot) stays as it is.
 */
function fold(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ''
  for (const c of text) {
    const l = c.toLowerCase()
    out += l.length === c.length ? l : c
  }
  return out
}

/** The lowercase paths of each list, computed once per list rather than at each keystroke. */
const lowered = new WeakMap<string[], string[]>()

/**
 * The paths holding the characters of `query` in order (case ignored), most relevant first:
 * the file named like it, then names starting with it, holding it, paths holding it, then scattered letters,
 * ties going to the shorter path. At most `limit` paths.
 */
export function rankPaths(paths: string[], query: string, limit = Infinity): string[] {
  const q = fold(query)
  if (q === '') return []
  let lowers = lowered.get(paths)
  if (!lowers) {
    lowers = paths.map(fold)
    lowered.set(paths, lowers)
  }
  const found: { path: string; tier: Tier; quality: number }[] = []
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]
    const s = score(path, lowers[i], q)
    if (s) found.push({ path, tier: s[0], quality: s[1] })
  }
  found.sort((a, b) =>
    b.tier - a.tier || b.quality - a.quality || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return found.slice(0, limit).map((f) => f.path)
}
