import { isPromptSafe, type DepEntry, type DepsReport, type Severity } from '../../shared/deps'

const LEVEL_LABEL: Record<DepEntry['level'], string> = {
  critical: 'Critique', soon: 'À prévoir', later: 'Peut attendre', private: 'Non vérifiée', pinless: 'Non épinglée'
}
const SEVERITY_WORD: Record<Severity, string> = { critical: 'critique', high: 'haute', moderate: 'modérée', low: 'faible', unknown: 'de gravité inconnue' }
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 }
/** Names shown in the banner before it summarizes. */
const BANNER_NAMES = 3

export function levelLabel(l: DepEntry['level']): string {
  return LEVEL_LABEL[l]
}

/** The critical entries are pre-checked; nothing else. */
export function initialSelection(entries: DepEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.level === 'critical').map((e) => e.key))
}

/**
 * After a background check of the same repo: the user's ticks that still apply, plus the entries that just became
 * critical (those are pre-checked as on a first load). A repo change starts over with `initialSelection`.
 */
export function nextSelection(ticks: Set<string>, before: DepEntry[], after: DepEntry[]): Set<string> {
  const wasCritical = new Set(before.filter((e) => e.level === 'critical').map((e) => e.key))
  const next = new Set<string>()
  for (const e of after) {
    if (!canSelect(e)) continue
    if (ticks.has(e.key) || (e.level === 'critical' && !wasCritical.has(e.key))) next.add(e.key)
  }
  return next
}

/** A private or local source is never checked, so it cannot be handed to Claude either. */
export function canSelect(e: DepEntry): boolean {
  return e.level !== 'private'
}

/** What « tout cocher » checks: a private or unpinned entry has no target to update to. */
export function selectableKeys(entries: DepEntry[]): string[] {
  return entries.filter((e) => e.level !== 'private' && e.level !== 'pinless').map((e) => e.key)
}

/** Built from the cause, never from `reason`: that text may be long and partly author-controlled. */
function problem(e: DepEntry): string {
  if (e.cause === 'advisory') {
    const top = [...e.advisories].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0]
    return `faille ${SEVERITY_WORD[top?.severity ?? 'unknown']} dans ${e.name}`
  }
  if (e.cause === 'yanked') return `version de ${e.name} retirée`
  return `${e.name} n'est plus maintenu`
}

/** « 2 dépendances critiques dans canopy : faille critique dans tar, request n'est plus maintenu ». */
export function bannerText(entries: DepEntry[], repoName: string): string {
  const critical = entries.filter((e) => e.level === 'critical')
  const n = critical.length
  const head = `${n} ${n > 1 ? 'dépendances critiques' : 'dépendance critique'} dans ${repoName}`
  const names = critical.slice(0, BANNER_NAMES).map(problem).join(', ')
  const rest = n - BANNER_NAMES
  return `${head} : ${names}${rest > 0 ? ` … et ${rest} ${rest > 1 ? 'autres' : 'autre'}` : ''}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** « Dernière vérification : il y a 3 h »; empty before the first check. */
export function lastCheckText(r: DepsReport, now: number): string {
  if (r.checkedAt === null) return ''
  const diff = now - r.checkedAt
  const ago = diff < MINUTE ? 'à l\'instant'
    : diff < HOUR ? `il y a ${Math.floor(diff / MINUTE)} min`
      : diff < DAY ? `il y a ${Math.floor(diff / HOUR)} h`
        : `il y a ${Math.floor(diff / DAY)} j`
  return `Dernière vérification : ${ago}`
}

/** The last-check line, with the first error when the check had any (the full list is shown under the table). */
export function statusLine(r: DepsReport, now: number): string {
  const line = lastCheckText(r, now)
  if (!r.errors.length) return line
  return line ? `${line} · échec : ${r.errors[0]}` : `Échec : ${r.errors[0]}`
}

/** What the screen says for a report without any dependency file: why the repo was skipped, when it was. */
export function emptyNotes(r: DepsReport): string[] {
  return r.errors.length ? r.errors : ['Aucun fichier de dépendances reconnu']
}

/** The entries `depsLaunchPrompt` keeps, and the ones it drops for an unusual name or path (shown to the user). */
export function promptSplit(entries: DepEntry[]): { safe: DepEntry[]; unsafe: DepEntry[] } {
  const safe: DepEntry[] = [], unsafe: DepEntry[] = []
  for (const e of entries) (isPromptSafe(e) ? safe : unsafe).push(e)
  return { safe, unsafe }
}
