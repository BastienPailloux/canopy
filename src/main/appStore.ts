import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { LinearLink } from '../shared/linear'
import type { AutoMergeEntry } from '../shared/pr'

const MAX_RECENT = 10
const MAX_BRANCH_HISTORY = 50

/** The part of Electron's `safeStorage` the store needs (the macOS keychain). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Thrown when the key cannot be encrypted: it is never stored in clear. */
export class EncryptionUnavailableError extends Error {
  constructor(message = "Le trousseau macOS n'est pas disponible : la clé API n'a pas été enregistrée.") {
    super(message)
    this.name = 'EncryptionUnavailableError'
  }
}

/** The OAuth state of the Linear connection (SDK client registration, tokens, PKCE verifier); `expired`: Linear refused the tokens. */
export interface LinearAuthState { client?: unknown; tokens?: unknown; verifier?: string; expired?: boolean }

interface State {
  recentRepos: string[]
  /** Hashes of the project configs sessions may load, by main worktree root. */
  approvedConfigs: Record<string, string[]>
  ports: Record<string, Record<string, number>>
  /** Base branch picked for a repo, by main worktree root. */
  repoBases: Record<string, string>
  /** Base of a stacked branch, by main worktree root then branch. */
  branchBases: Record<string, Record<string, string>>
  /** Launched Linear issues, by main worktree root then issue id. */
  linearLinks: Record<string, Record<string, LinearLink>>
  /** Branches checked out in each worktree, most recent last. */
  branchHistory: Record<string, string[]>
  /** Auto-merges enabled from the PR tab and still pending, by worktree. */
  autoMerges: Record<string, AutoMergeEntry>
  /** Worktree last selected in each recent folder. */
  lastEntries: Record<string, string>
  prefs: Record<string, unknown>
  /** PATH of the last login shell env that resolved, to start with while the next one resolves. */
  loginPath?: string
  /** The Anthropic API key, encrypted with `safeStorage` and base64 encoded. */
  apiKey?: string
  /** `LinearAuthState` as JSON, encrypted with `safeStorage` and base64 encoded. */
  linearAuth?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates each field on its own: a bad field resets to its default, the rest is kept. */
function sanitize(raw: unknown): State {
  const state: State = { recentRepos: [], approvedConfigs: {}, ports: {}, repoBases: {}, branchBases: {}, linearLinks: {}, branchHistory: {}, autoMerges: {}, lastEntries: {}, prefs: {} }
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
  if (isRecord(raw.branchBases)) {
    for (const [root, branches] of Object.entries(raw.branchBases)) {
      if (!isRecord(branches)) continue
      const clean = Object.entries(branches).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
      if (clean.length > 0) state.branchBases[root] = Object.fromEntries(clean)
    }
  }
  if (isRecord(raw.linearLinks)) {
    for (const [root, links] of Object.entries(raw.linearLinks)) {
      if (!isRecord(links)) continue
      const clean: Record<string, LinearLink> = {}
      for (const [id, l] of Object.entries(links)) {
        if (isRecord(l) && typeof l.branch === 'string' && typeof l.worktree === 'string' && typeof l.base === 'string') {
          clean[id] = { branch: l.branch, worktree: l.worktree, base: l.base }
        }
      }
      if (Object.keys(clean).length > 0) state.linearLinks[root] = clean
    }
  }
  if (isRecord(raw.branchHistory)) {
    for (const [wt, branches] of Object.entries(raw.branchHistory)) {
      if (!isAbsolute(wt) || !Array.isArray(branches)) continue
      const clean = [...new Set(branches.filter((b): b is string => typeof b === 'string' && b !== ''))].slice(-MAX_BRANCH_HISTORY)
      if (clean.length > 0) state.branchHistory[wt] = clean
    }
  }
  if (isRecord(raw.autoMerges)) {
    for (const [wt, e] of Object.entries(raw.autoMerges)) {
      if (isAbsolute(wt) && isRecord(e) && typeof e.number === 'number' && Number.isSafeInteger(e.number) && e.number > 0 &&
        typeof e.branch === 'string' && e.branch !== '' && typeof e.headOid === 'string' && e.headOid !== '' && typeof e.cleanup === 'boolean') {
        state.autoMerges[wt] = { number: e.number, branch: e.branch, headOid: e.headOid, cleanup: e.cleanup }
      }
    }
  }
  if (isRecord(raw.lastEntries)) {
    for (const [folder, path] of Object.entries(raw.lastEntries)) if (typeof path === 'string' && path !== '') state.lastEntries[folder] = path
  }
  if (isRecord(raw.prefs)) state.prefs = raw.prefs
  if (typeof raw.loginPath === 'string' && raw.loginPath !== '') state.loginPath = raw.loginPath
  if (typeof raw.apiKey === 'string' && raw.apiKey !== '') state.apiKey = raw.apiKey
  if (typeof raw.linearAuth === 'string' && raw.linearAuth !== '') state.linearAuth = raw.linearAuth
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

  branchBase(root: string, branch: string): string | undefined {
    const bases = this.state.branchBases[root]
    return bases !== undefined && Object.hasOwn(bases, branch) ? bases[branch] : undefined
  }

  /** Remembers what `branch` was stacked on, or forgets it with null. */
  setBranchBase(root: string, branch: string, base: string | null): void {
    const bases = new Map(Object.entries(this.state.branchBases[root] ?? {}))
    if (base === null) bases.delete(branch)
    else bases.set(branch, base)
    if (bases.size === 0) delete this.state.branchBases[root]
    else this.state.branchBases[root] = Object.fromEntries(bases)
    this.save()
  }

  /** Main worktree roots holding launched Linear issues. */
  linearLinkRoots(): string[] {
    return Object.keys(this.state.linearLinks)
  }

  linearLinks(root: string): Record<string, LinearLink> {
    return { ...(this.state.linearLinks[root] ?? {}) }
  }

  /** Links a Linear issue to its launched branch, or forgets the link with null. */
  setLinearLink(root: string, id: string, link: LinearLink | null): void {
    const links = new Map(Object.entries(this.state.linearLinks[root] ?? {}))
    if (link === null) links.delete(id)
    else links.set(id, { ...link })
    if (links.size === 0) delete this.state.linearLinks[root]
    else this.state.linearLinks[root] = Object.fromEntries(links)
    this.save()
  }

  /** Notes `branch` as the latest checked out in `worktree`. */
  recordBranch(worktree: string, branch: string): void {
    const known = this.branchHistory(worktree)
    // worktree:list records on every poll: do not rewrite the file when nothing changed.
    if (known[known.length - 1] === branch) return
    const history = known.filter((b) => b !== branch)
    history.push(branch)
    this.state.branchHistory[worktree] = history.slice(-MAX_BRANCH_HISTORY)
    this.save()
  }

  branchHistory(worktree: string): string[] {
    return Object.hasOwn(this.state.branchHistory, worktree) ? [...this.state.branchHistory[worktree]] : []
  }

  forgetBranchHistory(worktree: string): void {
    if (!Object.hasOwn(this.state.branchHistory, worktree)) return
    delete this.state.branchHistory[worktree]
    this.save()
  }

  get autoMerges(): Record<string, AutoMergeEntry> { return { ...this.state.autoMerges } }

  /** Remembers the auto-merge enabled in `worktree`, or forgets it with null. */
  setAutoMerge(worktree: string, entry: AutoMergeEntry | null): void {
    if (entry === null) {
      if (!Object.hasOwn(this.state.autoMerges, worktree)) return
      delete this.state.autoMerges[worktree]
    } else {
      this.state.autoMerges[worktree] = { ...entry }
    }
    this.save()
  }

  /** Forgets the bases and Linear links of branches that no longer exist. */
  pruneBranchBases(root: string, existing: string[]): void {
    let changed = false
    const bases = this.state.branchBases[root]
    if (bases !== undefined) {
      const keep = Object.entries(bases).filter(([b]) => existing.includes(b))
      if (keep.length !== Object.keys(bases).length) {
        changed = true
        if (keep.length === 0) delete this.state.branchBases[root]
        else this.state.branchBases[root] = Object.fromEntries(keep)
      }
    }
    const links = this.state.linearLinks[root]
    if (links !== undefined) {
      const keep = Object.entries(links).filter(([, l]) => existing.includes(l.branch))
      if (keep.length !== Object.keys(links).length) {
        changed = true
        if (keep.length === 0) delete this.state.linearLinks[root]
        else this.state.linearLinks[root] = Object.fromEntries(keep)
      }
    }
    if (changed) this.save()
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

  /** The stored key in clear, or null when none is stored or it cannot be decrypted (keychain locked, app re-signed). */
  private decryptApiKey(): string | null {
    if (this.state.apiKey === undefined || !this.cipher?.isEncryptionAvailable()) return null
    try {
      return this.cipher.decryptString(Buffer.from(this.state.apiKey, 'base64'))
    } catch {
      return null
    }
  }

  /** `ANTHROPIC_API_KEY` if a key is stored and readable, else nothing: sessions then use the personal Claude login. */
  apiKeyEnv(): Record<string, string> {
    const key = this.decryptApiKey()
    return key ? { ANTHROPIC_API_KEY: key } : {}
  }

  /** False only when a key is stored but cannot be read back: it must then be entered again. */
  apiKeyReadable(): boolean {
    if (this.state.apiKey === undefined) return true
    return this.decryptApiKey() !== null
  }

  /** The stored Linear OAuth state, or null when none is stored or it cannot be decrypted. */
  linearAuth(): LinearAuthState | null {
    if (this.state.linearAuth === undefined || !this.cipher?.isEncryptionAvailable()) return null
    try {
      const v: unknown = JSON.parse(this.cipher.decryptString(Buffer.from(this.state.linearAuth, 'base64')))
      if (!isRecord(v)) return null
      return {
        ...(v.client !== undefined ? { client: v.client } : {}),
        ...(v.tokens !== undefined ? { tokens: v.tokens } : {}),
        ...(typeof v.verifier === 'string' ? { verifier: v.verifier } : {}),
        ...(v.expired === true ? { expired: true } : {}),
      }
    } catch {
      return null
    }
  }

  /** Stores the Linear OAuth state encrypted, or removes it with null. Throws `EncryptionUnavailableError` rather than store it in clear. */
  saveLinearAuth(s: LinearAuthState | null): void {
    if (s === null) {
      delete this.state.linearAuth
    } else {
      if (!this.cipher?.isEncryptionAvailable()) {
        throw new EncryptionUnavailableError("Le trousseau macOS n'est pas disponible : la connexion Linear n'a pas été enregistrée.")
      }
      this.state.linearAuth = this.cipher.encryptString(JSON.stringify(s)).toString('base64')
    }
    this.save()
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
