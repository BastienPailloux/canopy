import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_RECENT = 10

interface State {
  recentRepos: string[]
  /** Hashes of the project configs sessions may load, by main worktree root. */
  approvedConfigs: Record<string, string[]>
  ports: Record<string, Record<string, number>>
  prefs: Record<string, unknown>
  /** PATH of the last login shell env that resolved, to start with while the next one resolves. */
  loginPath?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates each field on its own: a bad field resets to its default, the rest is kept. */
function sanitize(raw: unknown): State {
  const state: State = { recentRepos: [], approvedConfigs: {}, ports: {}, prefs: {} }
  if (!isRecord(raw)) return state
  if (Array.isArray(raw.recentRepos)) {
    state.recentRepos = [...new Set(raw.recentRepos.filter((r): r is string => typeof r === 'string'))].slice(0, MAX_RECENT)
  }
  if (isRecord(raw.approvedConfigs)) {
    for (const [root, hashes] of Object.entries(raw.approvedConfigs)) {
      if (Array.isArray(hashes)) state.approvedConfigs[root] = [...new Set(hashes.filter((h): h is string => typeof h === 'string'))]
    }
  }
  if (isRecord(raw.ports)) {
    for (const [wt, services] of Object.entries(raw.ports)) {
      if (!isRecord(services)) continue
      const clean: Record<string, number> = {}
      for (const [name, port] of Object.entries(services)) if (typeof port === 'number') clean[name] = port
      state.ports[wt] = clean
    }
  }
  if (isRecord(raw.prefs)) state.prefs = raw.prefs
  if (typeof raw.loginPath === 'string' && raw.loginPath !== '') state.loginPath = raw.loginPath
  return state
}

/** App-wide state persisted as JSON. Atomic writes; a corrupt file yields defaults. */
export class AppStore {
  private state: State

  constructor(private readonly file: string) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = undefined
    }
    this.state = sanitize(raw)
  }

  get recentRepos(): string[] { return this.state.recentRepos }
  get ports(): State['ports'] { return this.state.ports }
  get loginPath(): string | undefined { return this.state.loginPath }
  get prefs(): Record<string, unknown> { return this.state.prefs }

  addRecentRepo(path: string): void {
    this.state.recentRepos = [path, ...this.state.recentRepos.filter((r) => r !== path)].slice(0, MAX_RECENT)
    this.save()
  }

  /** Whether any config of this repo was approved. Says nothing of the config a session would load. */
  isRepoTrusted(root: string): boolean {
    return (this.state.approvedConfigs[root] ?? []).length > 0
  }

  isConfigApproved(root: string, hash: string): boolean {
    return this.state.approvedConfigs[root]?.includes(hash) ?? false
  }

  approveConfig(root: string, hash: string): void {
    if (this.isConfigApproved(root, hash)) return
    this.state.approvedConfigs[root] = [...(this.state.approvedConfigs[root] ?? []), hash]
    this.save()
  }

  setPorts(worktree: string, ports: Record<string, number>): void {
    this.state.ports[worktree] = ports
    this.save()
  }

  setLoginPath(path: string): void {
    if (this.state.loginPath === path) return
    this.state.loginPath = path
    this.save()
  }

  setPrefs(prefs: Record<string, unknown>): void {
    this.state.prefs = prefs
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }
}
