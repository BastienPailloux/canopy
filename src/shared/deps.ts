export type Ecosystem = 'npm' | 'RubyGems' | 'PyPI'
export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'
/** Critique / À prévoir / Peut attendre */
export type Level = 'critical' | 'soon' | 'later'

/** A dependency as read from a lockfile. `private`: never sent to any service. */
export interface Dep { ecosystem: Ecosystem; name: string; version: string | null; manifest: string; private: boolean; via?: string[] }
export interface Advisory { id: string; package: string; severity: Severity; summary: string; fixed: string | null; url: string }
export interface PackageInfo { latest: string | null; deprecated: string | null; yanked: boolean; inactive: boolean; lastRelease: string | null }
export interface DepEntry {
  /** `${ecosystem}:${manifest}:${name}` */
  key: string
  ecosystem: Ecosystem; name: string; manifest: string
  installed: string | null; target: string | null
  /** pinless: requirements line without == */
  level: Level | 'private' | 'pinless'
  /** French, shown as is */
  reason: string
  advisories: Advisory[]; registryUrl: string | null
}
export interface DepsReport {
  repo: string; checkedAt: number | null; entries: DepEntry[]
  /** French, shown under the table */
  errors: string[]
  /** manifests 0: « Aucun fichier de dépendances reconnu » */
  baseRef: string | null; manifests: number
}

export const MAJORS_BEHIND = 2
export const STALE_YEARS = 2

const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 }
} as { [k: string]: { [v: string]: number } }

/** CVSS 3.x roundup (FIRST spec, appendix A), robust to float noise. */
function roundup(x: number): number {
  const i = Math.round(x * 100000)
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10
}

/** Base score from a CVSS 3.0/3.1 vector (FIRST spec, section 7.1); null when unparseable. */
function cvss3Score(vector: string): number | null {
  const parts = vector.split('/')
  if (parts[0] !== 'CVSS:3.0' && parts[0] !== 'CVSS:3.1') return null
  const m: Record<string, string> = {}
  for (const p of parts.slice(1)) { const [k, v] = p.split(':'); m[k] = v }
  const changed = m.S === 'C'
  if (m.S !== 'C' && m.S !== 'U') return null
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR as 'N' | 'L' | 'H']
  const av = W.AV[m.AV], ac = W.AC[m.AC], ui = W.UI[m.UI], c = W.CIA[m.C], i = W.CIA[m.I], a = W.CIA[m.A]
  if ([pr, av, ac, ui, c, i, a].some((v) => v === undefined)) return null
  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss
  if (impact <= 0) return 0
  const expl = 8.22 * av * ac * pr * ui
  return roundup(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10))
}

/** CVSS:3.0/3.1 only; anything else is 'unknown'. */
export function severityFromCvss(vector: string): Severity {
  const s = cvss3Score(vector)
  if (s === null) return 'unknown'
  return s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'moderate' : 'low'
}

export function depKey(d: Pick<Dep, 'ecosystem' | 'manifest' | 'name'>): string {
  return `${d.ecosystem}:${d.manifest}:${d.name}`
}

/** Numeric segments only: enough for common npm, gem and PEP 440 versions. */
function segments(v: string): number[] {
  return (v.match(/\d+/g) ?? []).map(Number)
}
function compare(a: string, b: string): number {
  const x = segments(a), y = segments(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}
const major = (v: string) => segments(v)[0] ?? 0

function registryUrl(d: Dep): string | null {
  if (d.private) return null
  const n = encodeURIComponent(d.name).replace(/%40/g, '@').replace(/%2F/g, '/')
  if (d.ecosystem === 'npm') return `https://www.npmjs.com/package/${n}`
  if (d.ecosystem === 'RubyGems') return `https://rubygems.org/gems/${n}`
  return `https://pypi.org/project/${n}/`
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Faille critique', high: 'Faille haute', moderate: 'Faille modérée', low: 'Faille faible', unknown: 'Faille de gravité inconnue'
}
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 }

function adviceReason(a: Advisory, d: Dep): string {
  let r = SEVERITY_LABEL[a.severity]
  if (a.package !== d.name) return `${r} dans ${a.package} (via ${d.via?.length ? d.via.join(' > ') : d.name})`
  if (a.summary) r += ` : ${a.summary}`
  return r
}

/** Highest-impact reason first; null when up to date. */
export function classify(d: Dep, advisories: Advisory[], info: PackageInfo | null, now: number): DepEntry | null {
  const base = { key: depKey(d), ecosystem: d.ecosystem, name: d.name, manifest: d.manifest, installed: d.version, advisories, registryUrl: registryUrl(d) }
  if (d.private) return { ...base, target: null, level: 'private', reason: 'Source privée ou locale : non vérifiée' }
  if (d.version === null) return { ...base, target: info?.latest ?? null, level: 'pinless', reason: 'Version non épinglée' }

  const sorted = [...advisories].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const top = sorted[0]
  const topRank = top ? SEVERITY_RANK[top.severity] : -1
  const latest = info?.latest ?? null

  let target = latest
  const fixes = advisories.map((a) => a.fixed).filter((f): f is string => !!f && major(f) === major(d.version!))
  if (fixes.length) target = fixes.reduce((a, b) => (compare(a, b) >= 0 ? a : b))
  const out = (level: Level, reason: string): DepEntry => ({ ...base, target, level, reason })

  if (top && topRank >= SEVERITY_RANK.high) return out('critical', adviceReason(top, d))
  if (info?.deprecated) return out('critical', `Déprécié : ${info.deprecated}`)
  if (info?.yanked) return out('critical', 'Version retirée par l\'auteur')
  if (info?.inactive) return out('critical', 'Projet déclaré inactif')
  if (top) return out('soon', adviceReason(top, d))
  if (!info) return null
  const behind = latest ? major(latest) - major(d.version) : 0
  if (behind >= MAJORS_BEHIND) return out('soon', `${behind} versions majeures de retard`)
  if (info.lastRelease) {
    const t = Date.parse(info.lastRelease)
    const limit = new Date(now)
    limit.setUTCFullYear(limit.getUTCFullYear() - STALE_YEARS)
    if (!Number.isNaN(t) && t < limit.getTime()) return out('soon', `Aucune publication depuis ${new Date(t).getUTCFullYear()}`)
  }
  if (latest && compare(latest, d.version) > 0) return out('later', 'Correctifs disponibles')
  return null
}

export function criticalKeys(r: DepsReport): string[] {
  return r.entries.filter((e) => e.level === 'critical').map((e) => e.key)
}

/** `fix/` when the selection contains an advisory (a security fix), `chore/` otherwise. */
export function defaultDepsBranch(entries: DepEntry[], today: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
  return `${entries.some((e) => e.advisories.length > 0) ? 'fix' : 'chore'}/deps-${date}`
}

export function depsLaunchPrompt(entries: DepEntry[]): string {
  const lines = entries.map((e) => {
    const ids = e.advisories.map((a) => a.id).join(', ')
    return `- ${e.name} (${e.ecosystem}, ${e.manifest}) : ${e.installed ?? '?'} → ${e.target ?? '?'}. ${e.reason}${ids ? ` [${ids}]` : ''}`
  })
  return [
    'Mets à jour les dépendances suivantes :',
    '',
    ...lines,
    '',
    'Utilise l\'outil du projet (npm, yarn, pnpm, bundler, pip…) pour appliquer les mises à jour et corriger les failles. Pense à tester (tests et typecheck).',
    'Si une mise à jour majeure te paraît risquée, pense à la signaler plutôt que de la forcer.',
    'Prépare ensuite la PR.'
  ].join('\n')
}
