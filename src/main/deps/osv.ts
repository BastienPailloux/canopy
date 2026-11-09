import { compareVersions, isValidPackageName, severityFromCvss, type Advisory, type Dep, type Severity } from '../../shared/deps'
import { createLimiter, type Http } from './http'

const BATCH = 1000
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const LABELS: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', MEDIUM: 'moderate', LOW: 'low' }

type Raw = Record<string, any>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null

const norm = (ecosystem: string, name: string) => (ecosystem === 'PyPI' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name)

/** Key of `advisoriesFor` results: advisories depend on the package version, not on the manifest that lists it. */
export const advisoryKey = (d: Pick<Dep, 'ecosystem' | 'name' | 'version'>) => `${d.ecosystem}:${norm(d.ecosystem, d.name)}@${d.version}`

/** What an advisory says, reduced to what we show: OSV documents can be large, only this is kept. */
export interface Detail { severity: Severity; summary: string
  /** Every `fixed` event, per affected package (name normalized). */
  fixes: { ecosystem: string; name: string; fixed: string }[] }
/** Advisory details by `${id}\0${modified}`: a changed advisory gets a new `modified`, so a hit is never stale. */
export type DetailCache = Map<string, Detail>
const CACHE_MAX = 5000
const sharedCache: DetailCache = new Map()

function severityOf(v: Raw): Severity {
  const label = v.database_specific?.severity
  if (typeof label === 'string' && Object.hasOwn(LABELS, label.toUpperCase())) return LABELS[label.toUpperCase()]
  const s = Array.isArray(v.severity) ? v.severity.find((x: Raw) => x?.type === 'CVSS_V3' && typeof x.score === 'string') : undefined
  return s ? severityFromCvss(s.score) : 'unknown'
}

function fixesOf(v: Raw): Detail['fixes'] {
  const out: Detail['fixes'] = []
  for (const a of Array.isArray(v.affected) ? v.affected : []) {
    if (!isObj(a) || typeof a.package?.ecosystem !== 'string' || typeof a.package?.name !== 'string') continue
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      for (const e of Array.isArray(r?.events) ? r.events : []) {
        if (typeof e?.fixed === 'string') out.push({ ecosystem: a.package.ecosystem, name: norm(a.package.ecosystem, a.package.name), fixed: e.fixed })
      }
    }
  }
  return out
}

/** Smallest `fixed` above the installed version among the entries about this package. */
function fixedOf(v: Detail, d: Dep): string | null {
  let best: string | null = null
  for (const f of v.fixes) {
    if (f.ecosystem !== d.ecosystem || f.name !== norm(d.ecosystem, d.name)) continue
    if (compareVersions(f.fixed, d.version!) > 0 && (best === null || compareVersions(f.fixed, best) < 0)) best = f.fixed
  }
  return best
}

function summaryOf(v: Raw): string {
  if (typeof v.summary === 'string') return v.summary
  return typeof v.details === 'string' ? v.details.split('\n')[0] : ''
}

/**
 * Advisories per queried package version (key = advisoryKey). Private, unpinned and invalidly named deps are never sent,
 * and a name@version listed by several manifests is asked once. Details are kept across calls in `cache` (successes only).
 * `next_page_token` of a batch result is ignored: batches are small enough that a dep with >1000 advisories is not a real case.
 */
export async function advisoriesFor(http: Http, deps: Dep[], cache: DetailCache = sharedCache): Promise<Map<string, Advisory[]>> {
  const out = new Map<string, Advisory[]>()
  const unique = new Map<string, Dep>()
  for (const d of deps) {
    if (d.private || d.version === null || !isValidPackageName(d.ecosystem, d.name)) continue
    const k = advisoryKey(d)
    if (!unique.has(k)) unique.set(k, d)
  }
  const eligible = [...unique.values()]
  const ids = new Map<Dep, { id: string; modified: string | null }[]>()
  for (let i = 0; i < eligible.length; i += BATCH) {
    const chunk = eligible.slice(i, i + BATCH)
    const res: any = await http.postJson('https://api.osv.dev/v1/querybatch', {
      queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version }))
    })
    // A partial answer would read as « no flaw »: fail, so the previous results are kept.
    if (!Array.isArray(res?.results) || res.results.length !== chunk.length) throw new Error('Réponse inattendue : https://api.osv.dev/v1/querybatch')
    const results = res.results as Raw[]
    chunk.forEach((d, j) => {
      const vulns = Array.isArray(results[j]?.vulns) ? results[j].vulns : []
      const byId = new Map<string, string | null>()
      for (const v of vulns) {
        if (typeof v?.id === 'string' && ID_RE.test(v.id) && !byId.has(v.id)) byId.set(v.id, typeof v.modified === 'string' ? v.modified : null)
      }
      ids.set(d, [...byId].map(([id, modified]) => ({ id, modified })))
    })
  }

  const limit = createLimiter(6)
  const details = new Map<string, Promise<Detail | null>>()
  const detail = (id: string, modified: string | null) => {
    const ck = modified === null ? null : `${id}\0${modified}`
    const hit = ck === null ? undefined : cache.get(ck)
    if (hit) return Promise.resolve(hit)
    let p = details.get(id)
    if (!p) {
      p = limit(async () => {
        try {
          const v = (await http.getJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`)).body
          return isObj(v) ? { severity: severityOf(v), summary: summaryOf(v), fixes: fixesOf(v) } : null
        } catch { return null }
      }).then((v) => {
        if (v && ck !== null) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
          cache.set(ck, v)
        }
        return v
      })
      details.set(id, p)
    }
    return p
  }

  await Promise.all(eligible.map(async (d) => {
    const list = await Promise.all((ids.get(d) ?? []).map(async ({ id, modified }): Promise<Advisory> => {
      const v = await detail(id, modified)
      const url = `https://osv.dev/vulnerability/${id}`
      // A failed lookup still shows the advisory: better a vague warning than a hidden flaw.
      if (!v) return { id, package: d.name, version: d.version!, severity: 'unknown', summary: '', fixed: null, url }
      return { id, package: d.name, version: d.version!, severity: v.severity, summary: v.summary, fixed: fixedOf(v, d), url }
    }))
    out.set(advisoryKey(d), list)
  }))
  return out
}
