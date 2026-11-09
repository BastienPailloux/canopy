import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { criticalKeys, type DepsReport } from '../../shared/deps'

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Parsing lockfiles runs on the main process: leave the app time to open first. */
export const FIRST_PASS_DELAY_MS = 30_000

export interface DepsServiceDeps {
  check: (repo: string, previous: DepsReport | null) => Promise<DepsReport>
  /**
   * Repos to watch: every git repo behind the picker's recent entries (a folder answers for the repos it holds).
   * `repos: null`: the entry could not be listed this time (unknown, not empty).
   */
  repos: () => Promise<{ entry: string; repos: string[] | null }[]>
  /** userData/deps-reports.json */
  file: string
  now: () => number
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  /** FIRST_PASS_DELAY_MS by default. */
  firstPassDelayMs?: number
  broadcast: (event: string, payload: unknown) => void
  /** Called for each repo dropped from the list: frees what the checks keep for it (parsed lockfiles). */
  forget?: (repo: string) => void
  log?: (msg: string, err: unknown) => void
}

/** Repo arguments are main worktree roots, as listed by `repos()`. */
export interface DepsService {
  /**
   * Loads the file (broadcasts nothing) and lists the repos, checks every repo after FIRST_PASS_DELAY_MS,
   * then again every CHECK_INTERVAL_MS. No-op when already started.
   */
  start(): void
  stop(): void
  report(repo: string): DepsReport | null
  /** After sleep: a pass over the repos whose report is missing or older than CHECK_INTERVAL_MS. Skipped while a pass runs. */
  checkOverdue(): Promise<void>
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrOrNull = (v: unknown) => v === null || isStr(v)
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const LEVELS = new Set(['critical', 'soon', 'later', 'private', 'pinless'])
const isAdvisory = (a: unknown) => isObj(a) && isStr(a.id) && isStr(a.package) && isStr(a.severity) && isStr(a.summary) && isStrOrNull(a.fixed) && isStr(a.url)
const isEntry = (e: unknown) => isObj(e) && isStr(e.key) && isStr(e.ecosystem) && isStr(e.name) && isStr(e.manifest) &&
  isStrOrNull(e.installed) && isStrOrNull(e.target) && isStr(e.level) && LEVELS.has(e.level) && isStr(e.cause) && isStr(e.reason) &&
  Array.isArray(e.advisories) && e.advisories.every(isAdvisory) && isStrOrNull(e.registryUrl)
/** The stored file is ours, but an older or damaged one must not crash the screens that read it. */
function isReport(r: unknown): r is DepsReport {
  return isObj(r) && isStr(r.repo) && (r.checkedAt === null || typeof r.checkedAt === 'number') && Array.isArray(r.entries) &&
    r.entries.every(isEntry) && isStrArray(r.errors) && isStrOrNull(r.baseRef) && typeof r.manifests === 'number'
}

export function createDepsService(d: DepsServiceDeps): DepsService {
  const log = d.log ?? ((msg: string, err: unknown) => console.error(msg, err))
  let reports: Record<string, DepsReport> = {}
  let dismissed: Record<string, string[]> = {}
  let entries: Entries | null = null
  const inflight = new Map<string, Promise<DepsReport>>()
  let timer: ReturnType<typeof setInterval> | null = null
  let firstPass: ReturnType<typeof setTimeout> | null = null
  let started = false

  function load(): void {
    try {
      const raw = JSON.parse(readFileSync(d.file, 'utf8'))
      if (!isObj(raw) || raw.version !== 1 || !isObj(raw.reports)) return
      // Each invalid report or dismissal is dropped on its own: the others still show.
      reports = Object.fromEntries(Object.entries(raw.reports).filter(([, r]) => isReport(r))) as Record<string, DepsReport>
      dismissed = isObj(raw.dismissed) ? (Object.fromEntries(Object.entries(raw.dismissed).filter(([, k]) => isStrArray(k))) as Record<string, string[]>) : {}
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
    const previous = entries
    // A transient failure must not drop what we knew: the entry keeps its last repos,
    // or before any listing, the stored repos under it.
    entries = (await d.repos()).map(({ entry, repos }) => ({
      entry,
      repos: repos ?? previous?.find((e) => e.entry === entry)?.repos ??
        Object.keys(reports).filter((r) => r === entry || r.startsWith(`${entry}/`))
    }))
    const keep = new Set(entries.flatMap((e) => e.repos))
    for (const r of new Set([...previous?.flatMap((e) => e.repos) ?? [], ...Object.keys(reports)])) if (!keep.has(r)) d.forget?.(r)
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

  let passRunning = false
  /** One pass at a time: a pass that would start during another is dropped, the running one covers it. */
  async function pass(due: (repo: string) => boolean = () => true): Promise<void> {
    if (passRunning) return
    passRunning = true
    try {
      let list: Entries
      try { list = await refreshEntries() } catch (e) { log('deps: cannot list repos', e); return }
      for (const repo of new Set(list.flatMap((e) => e.repos))) {
        if (!due(repo)) continue
        try { await runCheck(repo) } catch (e) { log(`deps: check failed for ${repo}`, e) }
      }
    } finally {
      passRunning = false
    }
  }
  const overdue = (repo: string) => { const at = reports[repo]?.checkedAt ?? null; return at === null || d.now() - at >= CHECK_INTERVAL_MS }

  const count = (repo: string) => { const r = reports[repo]; return r ? criticalKeys(r).length : 0 }

  return {
    start() {
      if (started) return
      started = true
      load()
      // The picker counts per entry need the list; stored reports show before any check.
      void refreshEntries().catch((e: unknown) => { log('deps: cannot list repos', e) })
      firstPass = d.setTimeout(() => {
        firstPass = null
        void pass()
        timer = d.setInterval(() => { void pass() }, CHECK_INTERVAL_MS)
      }, d.firstPassDelayMs ?? FIRST_PASS_DELAY_MS)
    },
    stop() {
      if (firstPass !== null) d.clearTimeout(firstPass)
      if (timer !== null) d.clearInterval(timer)
      firstPass = null
      timer = null
    },
    report: (repo) => reports[repo] ?? null,
    checkOverdue: () => pass(overdue),
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
