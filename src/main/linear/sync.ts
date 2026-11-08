import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { listGroup, statusGroup, type Departure, type LinearIssue, type LinearListState } from '../../shared/linear'
import { LinearExpiredError, type LinearClient } from './client'
import { LinearError } from './parse'

type SyncClient = Pick<LinearClient, 'listMine' | 'issueBrief' | 'connection'>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIssue = (v: unknown): v is LinearIssue =>
  isRecord(v) && typeof v.id === 'string' && typeof v.title === 'string' && isRecord(v.status) && typeof v.status.type === 'string'
/** Lookups of issues absent from `listMine` run this many at a time: parallel, without a burst on Linear. */
const LOOKUP_BATCH = 5

/** `f` on every item, `n` at a time, answers in order. */
async function mapBatched<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(f)))
  return out
}

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
  private listeners = new Set<(ids?: string[]) => void>()
  /** Issues the last sync changed, added, removed or reported departed. */
  private touched: string[] = []

  constructor(
    private readonly file: string,
    private readonly client: SyncClient,
    /** Launched issues: kept listed (unless deleted in Linear). */
    private readonly extra: () => string[] = () => [],
    private readonly now: () => Date = () => new Date(),
    /** Issues with an unsent edit: kept listed, even deleted in Linear (the last copy), until their queue is empty. */
    private readonly unsent: () => string[] = () => [],
    /** Launched issues Linear says no longer exist: their link is to be dropped, so they are never looked up again. */
    private readonly forget: (ids: string[]) => void = () => {},
  ) {
    this.load()
  }

  state(): LinearListState {
    const kept = this.kept()
    const issues = this.issues.filter((i) => listGroup(i.status, kept.has(i.id)) !== null)
    return {
      issues,
      fetchedAt: this.fetchedAt,
      error: this.error,
      expired: this.expired,
      departures: [...this.departures],
      kept: issues.filter((i) => kept.has(i.id)).map((i) => i.id),
    }
  }

  /** `l` gets the issues a change touched; none (`undefined`): anything may have changed. */
  onChange(l: (ids?: string[]) => void): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }

  ackDepartures(ids: string[]): void {
    const drop = new Set(ids)
    const next = this.departures.filter((d) => !drop.has(d.id))
    if (next.length === this.departures.length) return
    const acked = this.departures.filter((d) => drop.has(d.id)).map((d) => d.id)
    this.departures = next
    this.commit(acked)
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
    for (const l of [...this.listeners]) l(undefined)
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

  private pendingIds(): Set<string> {
    try { return new Set(this.unsent()) } catch { return new Set() }
  }

  /** Launched or with an unsent edit. */
  private kept(): Set<string> {
    return new Set([...this.launched(), ...this.pendingIds()])
  }

  private async run(): Promise<LinearListState> {
    const gen = this.generation
    this.touched = []
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
    this.commit(this.touched)
    return this.state()
  }

  private async sync(gen: number): Promise<void> {
    const all = await this.client.listMine()
    const me = this.client.connection().userId ?? this.me
    const byId = new Map(all.map((i) => [i.id, i]))
    const listed = all.filter((i) => statusGroup(i.status) !== null)
    const listedIds = new Set(listed.map((i) => i.id))
    const unsent = this.pendingIds()
    const launched = new Set([...this.launched(), ...unsent])
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

    const gone = [...prev.values()].filter((old) => !listedIds.has(old.id))
    const absent = [...launched].filter((id) => !listedIds.has(id) && !prev.has(id))
    const answers = await mapBatched([...gone.map((o) => o.id), ...absent], LOOKUP_BATCH, lookup)
    const answer = new Map([...gone.map((o) => o.id), ...absent].map((id, n) => [id, answers[n]]))
    // Deleted in Linear: reported once, then its link goes, so it is never looked up again. Not while an edit waits.
    const forgotten: string[] = []

    for (const old of gone) {
      const id = old.id
      const r = answer.get(id) ?? 'failed'
      if (r === 'failed') { kept.push(old); continue }
      if (launched.has(id) && r !== 'missing') { kept.push(r); continue }
      // Deleted in Linear, but Bastien's edit still waits: the row stays so he sees it and decides.
      if (unsent.has(id)) { kept.push(old); continue }
      if (r === 'missing') {
        newDepartures.push({ id, title: old.title, reason: 'missing' })
        if (launched.has(id)) forgotten.push(id)
        continue
      }
      if (statusGroup(r.status) === null) { newDepartures.push({ id, title: r.title, reason: 'canceled' }); continue }
      const reassigned = me !== null ? (r.assignee?.id ?? null) !== me : (r.assignee?.id ?? null) !== (old.assignee?.id ?? null)
      if (reassigned) { newDepartures.push({ id, title: r.title, reason: 'reassigned' }); continue }
      kept.push(r)
    }
    for (const id of absent) {
      const r = answer.get(id) ?? 'failed'
      if (r === 'missing' && !unsent.has(id)) {
        newDepartures.push({ id, title: id, reason: 'missing' })
        forgotten.push(id)
      } else if (r !== 'missing' && r !== 'failed') kept.push(r)
    }

    if (gen !== this.generation) return
    const order = new Map([...this.issues].map((i, n) => [i.id, n]))
    const next = [...listed, ...kept].sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1))
    const nextById = new Map(next.map((i) => [i.id, i]))
    const touched = new Set(newDepartures.map((d) => d.id))
    for (const i of next) if (JSON.stringify(prev.get(i.id)) !== JSON.stringify(i)) touched.add(i.id)
    for (const id of prev.keys()) if (!nextById.has(id)) touched.add(id)
    this.touched = [...touched]
    this.issues = next
    const back = new Set(this.issues.map((i) => i.id))
    const fresh = new Set(newDepartures.map((d) => d.id))
    this.departures = [...this.departures.filter((d) => !back.has(d.id) && !fresh.has(d.id)), ...newDepartures]
    this.fetchedAt = this.now().toISOString()
    this.me = me
    if (forgotten.length > 0) {
      try { this.forget(forgotten) } catch (e) { console.error('linear link removal failed', e) }
    }
  }

  private commit(ids?: string[]): void {
    this.save()
    for (const l of [...this.listeners]) l(ids)
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
