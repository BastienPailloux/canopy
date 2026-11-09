import { compareVersions, depKey, isValidPackageName, severityFromCvss, type Advisory, type Dep, type Severity } from '../../shared/deps'
import { createLimiter, type Http } from './http'

const BATCH = 1000
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const LABELS: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', MEDIUM: 'moderate', LOW: 'low' }

type Raw = Record<string, any>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null

const norm = (ecosystem: string, name: string) => (ecosystem === 'PyPI' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name)

function severityOf(v: Raw): Severity {
  const label = v.database_specific?.severity
  if (typeof label === 'string' && Object.hasOwn(LABELS, label.toUpperCase())) return LABELS[label.toUpperCase()]
  const s = Array.isArray(v.severity) ? v.severity.find((x: Raw) => x?.type === 'CVSS_V3' && typeof x.score === 'string') : undefined
  return s ? severityFromCvss(s.score) : 'unknown'
}

/** Smallest `fixed` above the installed version among the ranges of the entries about this package. */
function fixedOf(v: Raw, d: Dep): string | null {
  let best: string | null = null
  for (const a of Array.isArray(v.affected) ? v.affected : []) {
    if (!isObj(a) || a.package?.ecosystem !== d.ecosystem || typeof a.package?.name !== 'string' || norm(d.ecosystem, a.package.name) !== norm(d.ecosystem, d.name)) continue
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      for (const e of Array.isArray(r?.events) ? r.events : []) {
        if (typeof e?.fixed !== 'string') continue
        if (compareVersions(e.fixed, d.version!) > 0 && (best === null || compareVersions(e.fixed, best) < 0)) best = e.fixed
      }
    }
  }
  return best
}

function summaryOf(v: Raw): string {
  if (typeof v.summary === 'string') return v.summary
  return typeof v.details === 'string' ? v.details.split('\n')[0] : ''
}

/**
 * Advisories per queried dep (key = depKey). Private, unpinned and invalidly named deps are never sent.
 * `next_page_token` of a batch result is ignored: batches are small enough that a dep with >1000 advisories is not a real case.
 */
export async function advisoriesFor(http: Http, deps: Dep[]): Promise<Map<string, Advisory[]>> {
  const out = new Map<string, Advisory[]>()
  const eligible = deps.filter((d) => !d.private && d.version !== null && isValidPackageName(d.ecosystem, d.name))
  const ids = new Map<Dep, string[]>()
  for (let i = 0; i < eligible.length; i += BATCH) {
    const chunk = eligible.slice(i, i + BATCH)
    const res: any = await http.postJson('https://api.osv.dev/v1/querybatch', {
      queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version }))
    })
    const results = Array.isArray(res?.results) ? res.results : []
    chunk.forEach((d, j) => {
      const vulns = Array.isArray(results[j]?.vulns) ? results[j].vulns : []
      ids.set(d, [...new Set<string>(vulns.map((v: Raw) => v?.id).filter((id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)))])
    })
  }

  const limit = createLimiter(6)
  const details = new Map<string, Promise<Raw | null>>()
  const detail = (id: string) => {
    let p = details.get(id)
    if (!p) {
      p = limit(async () => {
        try { const v = await http.getJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`); return isObj(v) ? v : null } catch { return null }
      })
      details.set(id, p)
    }
    return p
  }

  await Promise.all(eligible.map(async (d) => {
    const list = await Promise.all((ids.get(d) ?? []).map(async (id): Promise<Advisory> => {
      const v = await detail(id)
      const url = `https://osv.dev/vulnerability/${id}`
      // A failed lookup still shows the advisory: better a vague warning than a hidden flaw.
      if (!v) return { id, package: d.name, severity: 'unknown', summary: '', fixed: null, url }
      return { id, package: d.name, severity: severityOf(v), summary: summaryOf(v), fixed: fixedOf(v, d), url }
    }))
    out.set(depKey(d), list)
  }))
  return out
}
