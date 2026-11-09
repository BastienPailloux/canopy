import { classify, depKey, isValidPackageName, type Advisory, type Dep, type DepEntry, type DepsReport, type PackageInfo } from '../../shared/deps'
import { createLimiter, HttpError, type Http } from './http'
import { advisoriesFor, advisoryKey } from './osv'
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
  // Offline, every package fails the same way: one line per ecosystem and reason, not one per package.
  const registryFailures = new Map<string, { ecosystem: string; why: string; names: string[] }>()
  let registryAnswers = 0
  for (const u of inventory.units) {
    for (const d of u.deps) {
      jobs.push((async () => {
        const key = depKey(d)
        const known = prev.get(key)
        // What was known about another installed version says nothing about this one.
        const before = known?.installed === d.version ? known : undefined
        let advisories: Advisory[]
        if (osvFailed) advisories = before?.advisories ?? []
        else {
          advisories = [...(found.get(advisoryKey(d)) ?? [])]
          for (const t of u.transitive) if (t.via?.[0] === d.name && t.manifest === d.manifest) advisories.push(...(found.get(advisoryKey(t)) ?? []))
        }
        // A failed detail lookup yields 'unknown': keep the severity we already knew.
        advisories = advisories.map((a) => {
          if (a.severity !== 'unknown') return a
          const old = known?.advisories.find((b) => b.id === a.id)
          if (!old || old.severity === 'unknown') return a
          // An advisory's severity is the same for every version, its fix target is not.
          return before ? old : { ...a, severity: old.severity }
        })
        let info: PackageInfo | null = null
        let failed = osvFailed
        if (!d.private && isValidPackageName(d.ecosystem, d.name)) {
          try {
            info = await limit(() => getInfo(deps.http, d))
            registryAnswers++
          } catch (e) {
            const why = e instanceof HttpError ? `HTTP ${e.status}` : messageOf(e)
            const k = `${d.ecosystem}\0${why}`
            const group = registryFailures.get(k) ?? { ecosystem: d.ecosystem, why, names: [] }
            group.names.push(d.name)
            registryFailures.set(k, group)
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
  for (const { ecosystem, why, names } of registryFailures.values()) {
    errors.push(names.length === 1 ? `${ecosystem} : ${names[0]} non vérifié (${why})` : `${ecosystem} : ${names.length} paquets non vérifiés (${why})`)
  }
  const uniqueErrors = [...new Set(errors)].sort()
  entries.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name, 'fr') || a.manifest.localeCompare(b.manifest))

  // Nothing answered: not a check, so the screen keeps showing when the last real one was.
  const checkedAt = osvFailed && registryAnswers === 0 ? previous?.checkedAt ?? null : deps.now()
  return { repo: inventory.repo, checkedAt, entries, errors: uniqueErrors, baseRef: inventory.baseRef, manifests: inventory.units.length }
}
