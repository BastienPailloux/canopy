export type Ecosystem = 'npm' | 'RubyGems' | 'PyPI'
export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'
/** Critique / À prévoir / Peut attendre */
export type Level = 'critical' | 'soon' | 'later'

/** A dependency as read from a lockfile. `private`: never sent to any service. */
export interface Dep { ecosystem: Ecosystem; name: string; version: string | null; manifest: string; private: boolean; via?: string[]
  /** Set only when private because a strict unit (pnpm, yarn berry) has no registry declared for this scope, e.g. '@babel'. */
  unmappedScope?: string }
export interface Advisory { id: string; package: string
  /** The version of `package` it was found for; absent in reports stored before it existed. */
  version?: string
  severity: Severity; summary: string; fixed: string | null; url: string }
export interface PackageInfo { latest: string | null; deprecated: string | null; yanked: boolean; inactive: boolean; lastRelease: string | null }
export interface DepEntry {
  /** `${ecosystem}:${manifest}:${name}` */
  key: string
  ecosystem: Ecosystem; name: string; manifest: string
  installed: string | null; target: string | null
  /** pinless: requirements line without == */
  level: Level | 'private' | 'pinless'
  /** What produced `reason`; the launch prompt uses it instead of the (partly author-controlled) text. */
  cause: Cause
  /** French, shown as is */
  reason: string
  advisories: Advisory[]; registryUrl: string | null
  /** Private entries only: the scope whose registry is not declared (see `Dep.unmappedScope`). */
  unmappedScope?: string
}
export interface DepsReport {
  repo: string; checkedAt: number | null; entries: DepEntry[]
  /** French, shown under the table */
  errors: string[]
  /** manifests 0: « Aucun fichier de dépendances reconnu » */
  baseRef: string | null; manifests: number
}

export type Cause = 'advisory' | 'deprecated' | 'yanked' | 'inactive' | 'majors' | 'stale' | 'patches' | 'private' | 'pinless'

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
  const m: Record<string, string> = Object.create(null)
  for (const p of parts.slice(1)) { const [k, v] = p.split(':'); m[k] = v }
  const changed = m.S === 'C'
  if (m.S !== 'C' && m.S !== 'U') return null
  const PR: Record<string, number> = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }
  const weight = (t: Record<string, number>, k: string | undefined) => (k !== undefined && Object.hasOwn(t, k) ? t[k] : NaN)
  const pr = weight(PR, m.PR), av = weight(W.AV, m.AV), ac = weight(W.AC, m.AC), ui = weight(W.UI, m.UI)
  const c = weight(W.CIA, m.C), i = weight(W.CIA, m.I), a = weight(W.CIA, m.A)
  if (![pr, av, ac, ui, c, i, a].every(Number.isFinite)) return null
  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss
  if (impact <= 0) return 0
  const expl = 8.22 * av * ac * pr * ui
  const score = roundup(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10))
  return Number.isFinite(score) ? score : null
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

/**
 * Leading numeric release segments, then what follows: enough for common npm, gem and PEP 440 versions.
 * `stage`: -1 for a prerelease (`-rc.1`, `rc1`, `.beta.2`...), 1 for a PEP 440 post release, 0 for the release.
 * Build metadata (`+...`) is ignored.
 */
function parseVersion(v: string): { release: number[]; stage: number; tag: string[] } {
  const m = /^\D*?(\d+(?:\.\d+)*)(.*)$/.exec(v.split('+')[0].trim())
  if (!m) return { release: [], stage: 0, tag: [] }
  const rest = m[2].replace(/^[.-]/, '')
  const tag = rest.match(/\d+|[A-Za-z]+/g) ?? []
  const stage = tag.length === 0 ? 0 : /^(post|rev|r)$/i.test(tag[0] ?? '') ? 1 : -1
  return { release: m[1].split('.').map(Number), stage, tag }
}
const segments = (v: string) => parseVersion(v).release
function compare(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) {
    const d = (x.release[i] ?? 0) - (y.release[i] ?? 0)
    if (d) return d
  }
  if (x.stage !== y.stage) return x.stage - y.stage
  // Semver identifier order: numbers numerically, below words; words in ASCII order; fewer identifiers first.
  for (let i = 0; i < Math.max(x.tag.length, y.tag.length); i++) {
    const p = x.tag[i], q = y.tag[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); continue }
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p.toLowerCase() < q.toLowerCase() ? -1 : 1
  }
  return 0
}
export { compare as compareVersions }

/**
 * Index of the segment that is the major, caret style: the first non-zero one (0.3.x: 1, 0.0.3: 2), at most 2.
 * Two versions are in the same major when they agree up to it.
 */
const majorIndex = (release: number[]) => { const i = release.slice(0, 3).findIndex((n) => n !== 0); return i < 0 ? 2 : i }
function sameMajor(v: string, installed: string): boolean {
  const x = segments(v), y = segments(installed)
  for (let i = 0; i <= majorIndex(y); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return false
  return true
}
/** How many majors `latest` is ahead of `installed`, counted on the first segment that differs up to the installed major. */
function majorsBehind(latest: string, installed: string): number {
  const x = segments(latest), y = segments(installed)
  for (let i = 0; i <= majorIndex(y); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

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

/** Display-only: strip control characters (newlines become spaces) and cap the length. */
function cleanText(t: string): string {
  const c = t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim()
  return c.length > 200 ? c.slice(0, 199) + '…' : c
}

/** About this very package and version, not a transitive one (another copy of the same package included). */
const isOwn = (a: Advisory, d: Dep) => a.package === d.name && (a.version === undefined || a.version === d.version)

function adviceReason(a: Advisory, d: Dep): string {
  let r = SEVERITY_LABEL[a.severity]
  if (!isOwn(a, d)) {
    // Another copy of the same package: its version tells it apart.
    const what = a.package === d.name && a.version ? `${a.package} ${a.version}` : a.package
    return `${r} dans ${cleanText(what)} (via ${cleanText(d.via?.length ? d.via.join(' > ') : d.name)})`
  }
  if (a.summary) r += ` : ${cleanText(a.summary)}`
  return r
}

/** Highest-impact reason first; null when up to date. */
export function classify(d: Dep, advisories: Advisory[], info: PackageInfo | null, now: number): DepEntry | null {
  const base = { key: depKey(d), ecosystem: d.ecosystem, name: d.name, manifest: d.manifest, installed: d.version, advisories, registryUrl: registryUrl(d) }
  if (d.private) {
    const reason = d.unmappedScope ? 'Scope sans registre déclaré : non vérifié' : 'Source privée ou locale : non vérifiée'
    return { ...base, target: null, level: 'private', cause: 'private', reason, ...(d.unmappedScope ? { unmappedScope: d.unmappedScope } : {}) }
  }
  if (d.version === null) return { ...base, target: info?.latest ?? null, level: 'pinless', cause: 'pinless', reason: 'Version non épinglée' }

  const sorted = [...advisories].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const top = sorted[0]
  const topRank = top ? SEVERITY_RANK[top.severity] : -1
  const latest = info?.latest ?? null

  let target = latest
  // A transitive advisory's `fixed` is a version of the other package, not of this one.
  const own = advisories.filter((a) => isOwn(a, d))
  const inMajor = (f: string | null): f is string => !!f && sameMajor(f, d.version!)
  const unfixable = own.some((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK.high && !inMajor(a.fixed))
  const fixes = own.map((a) => a.fixed).filter(inMajor)
  if (fixes.length && !unfixable) target = fixes.reduce((a, b) => (compare(a, b) >= 0 ? a : b))
  const out = (level: Level, cause: Cause, reason: string): DepEntry => ({ ...base, target, level, cause, reason })

  if (top && topRank >= SEVERITY_RANK.high) return out('critical', 'advisory', adviceReason(top, d))
  if (info?.deprecated) return out('critical', 'deprecated', `Déprécié : ${cleanText(info.deprecated)}`)
  if (info?.yanked) return out('critical', 'yanked', 'Version retirée par l\'auteur')
  if (info?.inactive) return out('critical', 'inactive', 'Projet déclaré inactif')
  if (top) return out('soon', 'advisory', adviceReason(top, d))
  if (!info) return null
  const behind = latest ? majorsBehind(latest, d.version) : 0
  if (behind >= MAJORS_BEHIND) return out('soon', 'majors', `${behind} versions majeures de retard`)
  if (info.lastRelease) {
    const t = Date.parse(info.lastRelease)
    const limit = new Date(now)
    limit.setUTCFullYear(limit.getUTCFullYear() - STALE_YEARS)
    if (!Number.isNaN(t) && t < limit.getTime()) return out('soon', 'stale', `Aucune publication depuis ${new Date(t).getUTCFullYear()}`)
  }
  if (latest && compare(latest, d.version) > 0) return out('later', 'patches', 'Correctifs disponibles')
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

const NAME_RE: Record<Ecosystem, RegExp> = {
  npm: /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i,
  RubyGems: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  PyPI: /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/
}
/** Registry-syntax check on a name read from a lockfile (untrusted): gate before any URL or prompt use. */
export function isValidPackageName(ecosystem: Ecosystem, name: string): boolean {
  return NAME_RE[ecosystem]?.test(name) === true
}
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const VERSION_RE = /^[A-Za-z0-9.+_~-]{1,64}$/
const SEGMENT_RE = /^[A-Za-z0-9._@+-]+$/
const MANIFEST_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Gemfile', 'Gemfile.lock', 'pyproject.toml', 'Pipfile.lock', 'uv.lock', 'poetry.lock'])

/** True when every field that reaches the launch prompt is well-formed (no injected text). */
export function isPromptSafe(e: DepEntry): boolean {
  const segs = e.manifest.split('/')
  const base = segs[segs.length - 1]
  const manifestOk = e.manifest.length <= 200 && segs.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..') &&
    (MANIFEST_FILES.has(base) || /^requirements[A-Za-z0-9._-]*\.txt$/.test(base))
  return isValidPackageName(e.ecosystem, e.name) && manifestOk &&
    (e.installed === null || VERSION_RE.test(e.installed)) && (e.target === null || VERSION_RE.test(e.target)) &&
    e.advisories.every((a) => ID_RE.test(a.id))
}

const CAUSE_LABEL: Record<Cause, string> = {
  advisory: 'faille de sécurité', deprecated: 'paquet déprécié', yanked: 'version retirée', inactive: 'projet inactif',
  majors: 'versions majeures de retard', stale: 'plus de publication récente', patches: 'correctifs disponibles',
  private: 'source privée ou locale', pinless: 'version non épinglée'
}
const SEVERITY_WORD: Record<Severity, string> = { critical: 'critique', high: 'haute', moderate: 'modérée', low: 'faible', unknown: 'inconnue' }

/** Built only from fixed labels and validated identifiers: registry and advisory text is author-controlled. */
export function depsLaunchPrompt(entries: DepEntry[]): string {
  const lines = entries.filter(isPromptSafe).map((e) => {
    const ids = e.advisories.map((a) => `${a.id} (${SEVERITY_WORD[a.severity]})`).join(', ')
    return `- ${e.name} (${e.ecosystem}, ${e.manifest}) : ${e.installed ?? '?'} → ${e.target ?? '?'}. ${CAUSE_LABEL[e.cause]}${ids ? ` : ${ids}` : ''}`
  })
  return [
    'Mets à jour les dépendances suivantes :',
    '',
    ...lines,
    '',
    'Consulte toi-même chaque avis de sécurité et chaque page de registre pour les détails.',
    'Utilise l\'outil du projet (npm, yarn, pnpm, bundler, pip…) pour appliquer les mises à jour et corriger les failles, puis corriger ce qui casse après la mise à jour. Pense à tester (tests et typecheck).',
    'Si une mise à jour majeure te paraît risquée, pense à la signaler plutôt que de la forcer.',
    'Prépare ensuite la PR.'
  ].join('\n')
}
