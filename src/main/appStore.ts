import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_RECENT = 10

interface State {
  recentRepos: string[]
  ports: Record<string, Record<string, number>>
  prefs: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates each field on its own: a bad field resets to its default, the rest is kept. */
function sanitize(raw: unknown): State {
  const state: State = { recentRepos: [], ports: {}, prefs: {} }
  if (!isRecord(raw)) return state
  if (Array.isArray(raw.recentRepos)) {
    state.recentRepos = [...new Set(raw.recentRepos.filter((r): r is string => typeof r === 'string'))].slice(0, MAX_RECENT)
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
  get prefs(): Record<string, unknown> { return this.state.prefs }

  addRecentRepo(path: string): void {
    this.state.recentRepos = [path, ...this.state.recentRepos.filter((r) => r !== path)].slice(0, MAX_RECENT)
    this.save()
  }

  setPorts(worktree: string, ports: Record<string, number>): void {
    this.state.ports[worktree] = ports
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
