import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { statusGroup, type Departure, type LinearIssue, type LinearListState } from '../../shared/linear'
import { LinearExpiredError, type LinearClient } from './client'
import { LinearError } from './parse'

type SyncClient = Pick<LinearClient, 'listMine' | 'issueBrief' | 'connection'>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIssue = (v: unknown): v is LinearIssue =>
  isRecord(v) && typeof v.id === 'string' && typeof v.title === 'string' && isRecord(v.status) && typeof v.status.type === 'string'
const isDeparture = (v: unknown): v is Departure =>
  isRecord(v) && typeof v.id === 'string' && typeof v.title === 'string' &&
  (v.reason === 'reassigned' || v.reason === 'canceled' || v.reason === 'missing')

/** The Linear ticket list: last good answer cached on disk, never emptied by an error, departures explained. */
export class LinearSync {
  private issues: LinearIssue[] = []
  private fetchedAt: string | null = null
  private error: string | null = null
  private expired = false
  private departures: Departure[] = []
  /** Bastien's Linear user id, from `whoami` (the last one known): a launched issue kept with a new assignee still departs once unlaunched. */
  private me: string | null = null
  private generation = 0
  private inflight: Promise<LinearListState> | null = null
  private listeners = new Set<() => void>()

  constructor(
    private readonly file: string,
    private readonly client: SyncClient,
    private readonly extra: () => string[] = () => [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.load()
  }

  state(): LinearListState {
    return {
      issues: this.issues.filter((i) => statusGroup(i.status) !== null || this.launched().has(i.id)),
      fetchedAt: this.fetchedAt,
      error: this.error,
      expired: this.expired,
      departures: [...this.departures],
    }
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }

  ackDepartures(ids: string[]): void {
    const drop = new Set(ids)
    const next = this.departures.filter((d) => !drop.has(d.id))
    if (next.length === this.departures.length) return
    this.departures = next
    this.commit()
  }

  /** Wipes memory and disk (disconnect); a refresh already in flight is discarded. */
  clear(): void {
    this.generation++
    this.inflight = null
    this.issues = []
    this.fetchedAt = null
    this.error = null
    this.expired = false
    this.departures = []
    this.me = null
    try { rmSync(this.file, { force: true }) } catch (e) { console.error('linear cache removal failed', e) }
    for (const l of [...this.listeners]) l()
  }

  refresh(): Promise<LinearListState> {
    if (this.inflight) return this.inflight
    const p: Promise<LinearListState> = this.run().finally(() => { if (this.inflight === p) this.inflight = null })
    this.inflight = p
    return p
  }

  private launched(): Set<string> {
    try { return new Set(this.extra()) } catch { return new Set() }
  }

  private async run(): Promise<LinearListState> {
    const gen = this.generation
    try {
      await this.sync(gen)
      if (gen !== this.generation) return this.state()
      this.error = null
      this.expired = false
    } catch (e) {
      if (gen !== this.generation) return this.state()
      if (e instanceof LinearExpiredError || this.client.connection().state === 'expired') this.expired = true
      this.error = e instanceof Error ? e.message : String(e)
    }
    if (gen !== this.generation) return this.state()
    this.commit()
    return this.state()
  }

  private async sync(gen: number): Promise<void> {
    const all = await this.client.listMine()
    const me = this.client.connection().userId ?? this.me
    const byId = new Map(all.map((i) => [i.id, i]))
    const listed = all.filter((i) => statusGroup(i.status) !== null)
    const listedIds = new Set(listed.map((i) => i.id))
    const launched = this.launched()
    const prev = new Map(this.issues.map((i) => [i.id, i]))
    const kept: LinearIssue[] = []
    const newDepartures: Departure[] = []

    const lookup = async (id: string): Promise<LinearIssue | 'missing' | 'failed'> => {
      const known = byId.get(id)
      if (known) return known
      try { return await this.client.issueBrief(id) } catch (e) {
        return e instanceof LinearError && e.notFound ? 'missing' : 'failed'
      }
    }

    for (const [id, old] of prev) {
      if (listedIds.has(id)) continue
      const r = await lookup(id)
      if (r === 'failed') { kept.push(old); continue }
      if (launched.has(id) && r !== 'missing') { kept.push(r); continue }
      if (r === 'missing') { newDepartures.push({ id, title: old.title, reason: 'missing' }); continue }
      if (statusGroup(r.status) === null) { newDepartures.push({ id, title: r.title, reason: 'canceled' }); continue }
      const reassigned = me !== null ? (r.assignee?.id ?? null) !== me : (r.assignee?.id ?? null) !== (old.assignee?.id ?? null)
      if (reassigned) { newDepartures.push({ id, title: r.title, reason: 'reassigned' }); continue }
      kept.push(r)
    }
    for (const id of launched) {
      if (listedIds.has(id) || prev.has(id)) continue
      const r = await lookup(id)
      if (r !== 'missing' && r !== 'failed') kept.push(r)
    }

    if (gen !== this.generation) return
    const order = new Map([...this.issues].map((i, n) => [i.id, n]))
    this.issues = [...listed, ...kept].sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1))
    const back = new Set(this.issues.map((i) => i.id))
    const fresh = new Set(newDepartures.map((d) => d.id))
    this.departures = [...this.departures.filter((d) => !back.has(d.id) && !fresh.has(d.id)), ...newDepartures]
    this.fetchedAt = this.now().toISOString()
    this.me = me
  }

  private commit(): void {
    this.save()
    for (const l of [...this.listeners]) l()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ issues: this.issues, fetchedAt: this.fetchedAt, departures: this.departures, me: this.me }), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch { /* the cache is only an accelerator */ }
  }

  private load(): void {
    let text: string
    try { text = readFileSync(this.file, 'utf8') } catch { return }
    try {
      const raw: unknown = JSON.parse(text)
      if (!isRecord(raw) || !Array.isArray(raw.issues) || !raw.issues.every(isIssue)) throw new Error('bad cache')
      this.issues = raw.issues
      this.fetchedAt = typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null
      this.departures = Array.isArray(raw.departures) ? raw.departures.filter(isDeparture) : []
      this.me = typeof raw.me === 'string' ? raw.me : null
    } catch {
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* ignore */ }
    }
  }
}
