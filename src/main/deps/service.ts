import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { criticalKeys, type DepsReport } from '../../shared/deps'

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface DepsServiceDeps {
  check: (repo: string, previous: DepsReport | null) => Promise<DepsReport>
  /** Repos to watch: every git repo behind the picker's recent entries (a folder answers for the repos it holds). */
  repos: () => Promise<{ entry: string; repos: string[] }[]>
  /** userData/deps-reports.json */
  file: string
  now: () => number
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  broadcast: (event: string, payload: unknown) => void
  log?: (msg: string, err: unknown) => void
}

/** Repo arguments are main worktree roots, as listed by `repos()`. */
export interface DepsService {
  /** Loads the file (broadcasts nothing), checks every repo, then again every CHECK_INTERVAL_MS. No-op when already started. */
  start(): void
  stop(): void
  report(repo: string): DepsReport | null
  /** Rejects with « Dépôt inconnu » for a repo that is not listed, or with the check's error. */
  recheck(repo: string): Promise<DepsReport>
  /** Critical count of `path` (an entry or a repo), without `except` and its own repos. */
  critical(path: string, except?: string): number
  /** Whether the banner shows for `repo`: some critical key not in the dismissed set. */
  bannerFor(repo: string): boolean
  dismissBanner(repo: string): void
  checking(repo: string): boolean
}

type Entries = { entry: string; repos: string[] }[]

export function createDepsService(d: DepsServiceDeps): DepsService {
  const log = d.log ?? ((msg: string, err: unknown) => console.error(msg, err))
  let reports: Record<string, DepsReport> = {}
  let dismissed: Record<string, string[]> = {}
  let entries: Entries | null = null
  const inflight = new Map<string, Promise<DepsReport>>()
  let timer: ReturnType<typeof setInterval> | null = null
  let started = false

  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

  function load(): void {
    try {
      const raw = JSON.parse(readFileSync(d.file, 'utf8'))
      if (!isObject(raw) || raw.version !== 1 || !isObject(raw.reports)) return
      reports = raw.reports as Record<string, DepsReport>
      dismissed = isObject(raw.dismissed) ? (raw.dismissed as Record<string, string[]>) : {}
    } catch { /* missing or corrupt: start empty, and leave the file alone until a report is stored */ }
  }

  function persist(): void {
    try {
      const tmp = `${d.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, reports, dismissed }))
      renameSync(tmp, d.file)
    } catch (e) {
      log('deps: cannot write reports', e)
    }
  }

  const listed = (repo: string) => entries?.some((e) => e.repos.includes(repo)) === true

  async function refreshEntries(): Promise<Entries> {
    entries = await d.repos()
    const keep = new Set(entries.flatMap((e) => e.repos))
    let dropped = false
    for (const k of Object.keys(reports)) if (!keep.has(k)) { delete reports[k]; dropped = true }
    for (const k of Object.keys(dismissed)) if (!keep.has(k)) { delete dismissed[k]; dropped = true }
    if (dropped) persist()
    return entries
  }

  function runCheck(repo: string): Promise<DepsReport> {
    const running = inflight.get(repo)
    if (running) return running
    const p = d.check(repo, reports[repo] ?? null).then((r) => {
      // Dropped from the list while checking: hand the result back but do not keep it.
      if (listed(repo)) {
        reports[repo] = r
        persist()
        d.broadcast('deps:changed', { repo })
      }
      return r
    }).finally(() => { inflight.delete(repo) })
    inflight.set(repo, p)
    return p
  }

  async function pass(): Promise<void> {
    let list: Entries
    try { list = await refreshEntries() } catch (e) { log('deps: cannot list repos', e); return }
    for (const repo of new Set(list.flatMap((e) => e.repos))) {
      try { await runCheck(repo) } catch (e) { log(`deps: check failed for ${repo}`, e) }
    }
  }

  const count = (repo: string) => { const r = reports[repo]; return r ? criticalKeys(r).length : 0 }

  return {
    start() {
      if (started) return
      started = true
      load()
      void pass()
      timer = d.setInterval(() => { void pass() }, CHECK_INTERVAL_MS)
    },
    stop() {
      if (timer !== null) d.clearInterval(timer)
      timer = null
    },
    report: (repo) => reports[repo] ?? null,
    // Not async: a second call during a check must return the very same promise.
    recheck(repo) {
      if (entries && listed(repo)) return runCheck(repo)
      // Unknown, or the list is stale (a repo added since): read it again before refusing.
      return refreshEntries().then(() => {
        if (!listed(repo)) throw new Error('Dépôt inconnu')
        return runCheck(repo)
      })
    },
    critical(path, except) {
      const list = entries ?? []
      const excluded = new Set<string>()
      if (except !== undefined) {
        excluded.add(except)
        for (const e of list) if (e.entry === except) e.repos.forEach((r) => excluded.add(r))
      }
      const own = list.find((e) => e.entry === path)
      return (own ? own.repos : [path]).filter((r) => !excluded.has(r)).reduce((n, r) => n + count(r), 0)
    },
    bannerFor(repo) {
      const r = reports[repo]
      if (!r) return false
      const seen = new Set(dismissed[repo] ?? [])
      return criticalKeys(r).some((k) => !seen.has(k))
    },
    dismissBanner(repo) {
      const r = reports[repo]
      dismissed[repo] = r ? criticalKeys(r) : []
      persist()
      d.broadcast('deps:changed', { repo })
    },
    checking: (repo) => inflight.has(repo)
  }
}
