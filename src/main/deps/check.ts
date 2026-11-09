import { classify, depKey, isValidPackageName, type Advisory, type Dep, type DepEntry, type DepsReport, type PackageInfo } from '../../shared/deps'
import { createLimiter, HttpError, type Http } from './http'
import { advisoriesFor } from './osv'
import { packageInfo as defaultPackageInfo } from './registries'
import { readInventory } from './source'

export interface CheckDeps {
  http: Http
  now: () => number
  inventory?: typeof readInventory
  packageInfo?: (http: Http, d: Dep) => Promise<PackageInfo>
  advisories?: typeof advisoriesFor
}

const LEVEL_ORDER: Record<DepEntry['level'], number> = { critical: 0, soon: 1, later: 2, pinless: 3, private: 4 }
const rank = (e: DepEntry | null) => (e ? LEVEL_ORDER[e.level] : 5)
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Never throws except when the inventory itself cannot be read; lookup failures become `errors` and keep earlier results. */
export async function checkRepo(deps: CheckDeps, repo: string, previous: DepsReport | null): Promise<DepsReport> {
  const inventory = await (deps.inventory ?? readInventory)(repo)
  const getInfo = deps.packageInfo ?? defaultPackageInfo
  const errors: string[] = []
  const prev = new Map((previous?.entries ?? []).map((e) => [e.key, e]))

  for (const u of inventory.units) if (u.error) errors.push(u.error)
  errors.push(...inventory.notes)

  let found = new Map<string, Advisory[]>()
  let osvFailed = false
  try {
    found = await (deps.advisories ?? advisoriesFor)(deps.http, inventory.units.flatMap((u) => [...u.deps, ...u.transitive]))
  } catch (e) {
    osvFailed = true
    errors.push(`Failles non vérifiées : ${messageOf(e)}`)
  }

  const limit = createLimiter(6)
  const jobs: Promise<DepEntry | null>[] = []
  for (const u of inventory.units) {
    for (const d of u.deps) {
      jobs.push((async () => {
        const key = depKey(d)
        const before = prev.get(key)
        let advisories: Advisory[]
        if (osvFailed) advisories = before?.advisories ?? []
        else {
          advisories = [...(found.get(key) ?? [])]
          for (const t of u.transitive) if (t.via?.[0] === d.name) advisories.push(...(found.get(depKey(t)) ?? []))
        }
        // A failed detail lookup yields 'unknown': keep the severity we already knew.
        advisories = advisories.map((a) => {
          if (a.severity !== 'unknown') return a
          const old = before?.advisories.find((b) => b.id === a.id)
          return old && old.severity !== 'unknown' ? old : a
        })
        let info: PackageInfo | null = null
        let failed = osvFailed
        if (!d.private && isValidPackageName(d.ecosystem, d.name)) {
          try { info = await limit(() => getInfo(deps.http, d)) } catch (e) {
            const why = e instanceof HttpError ? `HTTP ${e.status}` : messageOf(e)
            errors.push(`${d.ecosystem} : ${d.name} non vérifié (${why})`)
            failed = true
          }
        }
        const entry = classify(d, advisories, info, deps.now())
        // A network failure must never make a known problem disappear or look milder.
        if (failed && before && rank(entry) >= rank(before)) return before
        return entry
      })())
    }
  }
  const entries = (await Promise.all(jobs)).filter((e): e is DepEntry => e !== null)
  const uniqueErrors = [...new Set(errors)].sort()
  entries.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name, 'fr') || a.manifest.localeCompare(b.manifest))

  return { repo: inventory.repo, checkedAt: deps.now(), entries, errors: uniqueErrors, baseRef: inventory.baseRef, manifests: inventory.units.length }
}
