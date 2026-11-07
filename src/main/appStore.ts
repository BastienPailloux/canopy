import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_RECENT = 10

/** The part of Electron's `safeStorage` the store needs (the macOS keychain). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Thrown when the key cannot be encrypted: it is never stored in clear. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super("Le trousseau macOS n'est pas disponible : la clé API n'a pas été enregistrée.")
    this.name = 'EncryptionUnavailableError'
  }
}

interface State {
  recentRepos: string[]
  /** Hashes of the project configs sessions may load, by main worktree root. */
  approvedConfigs: Record<string, string[]>
  ports: Record<string, Record<string, number>>
  /** Base branch picked for a repo, by main worktree root. */
  repoBases: Record<string, string>
  /** Worktree last selected in each recent folder. */
  lastEntries: Record<string, string>
  prefs: Record<string, unknown>
  /** PATH of the last login shell env that resolved, to start with while the next one resolves. */
  loginPath?: string
  /** The Anthropic API key, encrypted with `safeStorage` and base64 encoded. */
  apiKey?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates each field on its own: a bad field resets to its default, the rest is kept. */
function sanitize(raw: unknown): State {
  const state: State = { recentRepos: [], approvedConfigs: {}, ports: {}, repoBases: {}, lastEntries: {}, prefs: {} }
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
  if (isRecord(raw.repoBases)) {
    for (const [repo, base] of Object.entries(raw.repoBases)) if (typeof base === 'string' && base !== '') state.repoBases[repo] = base
  }
  if (isRecord(raw.lastEntries)) {
    for (const [folder, path] of Object.entries(raw.lastEntries)) if (typeof path === 'string' && path !== '') state.lastEntries[folder] = path
  }
  if (isRecord(raw.prefs)) state.prefs = raw.prefs
  if (typeof raw.loginPath === 'string' && raw.loginPath !== '') state.loginPath = raw.loginPath
  if (typeof raw.apiKey === 'string' && raw.apiKey !== '') state.apiKey = raw.apiKey
  return state
}

/** App-wide state persisted as JSON. Atomic writes; a corrupt file yields defaults. */
export class AppStore {
  private state: State

  constructor(private readonly file: string, private readonly cipher?: SecretCipher) {
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
  get repoBases(): Record<string, string> { return this.state.repoBases }
  get lastEntries(): Record<string, string> { return this.state.lastEntries }
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

  /** Repos with at least one approved config. */
  get trustedRepos(): string[] {
    return Object.keys(this.state.approvedConfigs).filter((root) => this.isRepoTrusted(root))
  }

  revokeRepo(root: string): void {
    delete this.state.approvedConfigs[root]
    this.save()
  }

  setPorts(worktree: string, ports: Record<string, number>): void {
    this.state.ports[worktree] = ports
    this.save()
  }

  /** Remembers the base branch of a repo (its main worktree root), or forgets it with null. */
  setRepoBase(repo: string, branch: string | null): void {
    if (branch === null) delete this.state.repoBases[repo]
    else this.state.repoBases[repo] = branch
    this.save()
  }

  /** Remembers the worktree selected in `folder`. Folders that left the recents are dropped: nothing reopens them. */
  setLastEntry(folder: string, path: string): void {
    const kept = Object.entries(this.state.lastEntries).filter(([f]) => this.state.recentRepos.includes(f))
    this.state.lastEntries = { ...Object.fromEntries(kept), [folder]: path }
    this.save()
  }

  setLoginPath(path: string): void {
    if (this.state.loginPath === path) return
    this.state.loginPath = path
    this.save()
  }

  /** Whether a key is stored. The key itself never leaves the main process. */
  hasApiKey(): boolean {
    return this.state.apiKey !== undefined
  }

  /** Stores the key encrypted, or removes it with null. Throws `EncryptionUnavailableError` rather than store it in clear. */
  saveApiKey(key: string | null): void {
    if (key === null || key === '') {
      delete this.state.apiKey
    } else {
      if (!this.cipher?.isEncryptionAvailable()) throw new EncryptionUnavailableError()
      this.state.apiKey = this.cipher.encryptString(key).toString('base64')
    }
    this.save()
  }

  /** `ANTHROPIC_API_KEY` if a key is stored and readable, else nothing: sessions then use the personal Claude login. */
  apiKeyEnv(): Record<string, string> {
    if (this.state.apiKey === undefined || !this.cipher?.isEncryptionAvailable()) return {}
    try {
      const key = this.cipher.decryptString(Buffer.from(this.state.apiKey, 'base64'))
      return key === '' ? {} : { ANTHROPIC_API_KEY: key }
    } catch {
      return {}
    }
  }

  get encryptionAvailable(): boolean {
    return this.cipher?.isEncryptionAvailable() === true
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
