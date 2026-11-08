import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LinearIssue } from '../../shared/linear'
import type { TicketPriority } from '../../shared/tickets'
import { LinearExpiredError, LinearNotConnectedError, type LinearClient } from './client'
import { rebase } from './descriptionPatch'
import { LinearError, LinearFormatError } from './parse'

/** Bastien's edit of a Linear issue: only the fields he changed. */
export interface LinearChange {
  title?: string
  /** `base`: the description as Linear gave it when Bastien started editing; `text`: his version. */
  description?: { base: string; text: string }
  statusId?: string
  priority?: TicketPriority
  labels?: string[]
  /** `null` removes the assignee. */
  assigneeId?: string | null
}

/**
 * - `sent`: Linear saved it. `issue` is the `save_issue` answer, which has no `parentId`, `cycle` nor `project`
 *   (always null there): do not trust those three fields from it, merge them with the cached copy.
 * - `pending`: not sent (network, expired or missing connection, Linear refusal); kept in the queue, `reason` in French.
 * - `conflict`: a colleague changed the same passage of the description; nothing was sent, the edit stays queued.
 */
export type SaveResult =
  | { kind: 'sent'; issue: LinearIssue }
  | { kind: 'pending'; reason: string }
  | { kind: 'conflict'; field: 'description'; remote: string; mine: string }

type Client = Pick<LinearClient, 'issueBrief' | 'save'>

interface Entry { id: string; change: LinearChange; error: string }

const PRIORITY_VALUE: Record<TicketPriority, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }

/**
 * `newer` on top of `older`, key by key. A description edited from the queued text (`newer.base === older.text`)
 * keeps the older base, the one Linear gave; any other base replaces the queued description (the newer edit was made
 * from that text).
 */
function merge(older: LinearChange | undefined, newer: LinearChange | undefined): LinearChange {
  const out: LinearChange = { ...older, ...newer }
  if (older?.description && newer?.description && newer.description.base === older.description.text) {
    out.description = { base: older.description.base, text: newer.description.text }
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isPatchFailure = (e: unknown): boolean => e instanceof LinearError && /patch/i.test(e.message)

function reasonOf(e: unknown): string {
  if (e instanceof LinearExpiredError || e instanceof LinearNotConnectedError || e instanceof LinearFormatError) return e.message
  if (e instanceof LinearError) return `Linear a refusé la modification : ${e.message}`
  return `Linear injoignable : ${e instanceof Error ? e.message : String(e)}`
}

const CONFLICT_REASON = 'Conflit : la description a aussi été modifiée dans Linear au même endroit.'

/**
 * Queue of Bastien's edits to Linear issues. Every edit is written to `file` before it is sent and removed once Linear
 * saved it, so an unsent edit survives a failure or a restart. Descriptions go out as `patch` ops rebased on Linear's
 * current text, so a colleague's edit elsewhere is kept and an edit of the same passage is a conflict, never an
 * overwrite. One send at a time per issue; a save arriving meanwhile is merged and sent after.
 */
export class LinearEdits {
  /** Waiting to be sent (or failed). */
  private readonly queued = new Map<string, LinearChange>()
  /** Being sent right now. */
  private readonly sending = new Map<string, LinearChange>()
  private readonly errors = new Map<string, string>()
  private readonly tails = new Map<string, Promise<SaveResult | undefined>>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string, private readonly client: Client) {
    for (const e of this.load()) {
      this.queued.set(e.id, e.change)
      this.errors.set(e.id, e.error)
    }
  }

  /** Queues `c` for `id` and sends it (after any send already in flight for `id`). */
  save(id: string, c: LinearChange): Promise<SaveResult> {
    this.queued.set(id, merge(this.queued.get(id), c))
    this.persist()
    this.emit()
    return this.schedule(id)
  }

  /** Every unsent edit; `error` is the last failure ('' while being sent for the first time). */
  pending(): Entry[] {
    const ids = new Set([...this.sending.keys(), ...this.queued.keys()])
    return [...ids].map((id) => ({
      id,
      change: structuredClone(merge(this.sending.get(id), this.queued.get(id))),
      error: this.errors.get(id) ?? '',
    }))
  }

  async retryAll(): Promise<void> {
    await Promise.all([...this.queued.keys()].map((id) => this.schedule(id)))
  }

  /** Drops the queued edit of `id`. Only on Bastien's explicit choice. A send already in flight is not cancelled. */
  discard(id: string): void {
    this.queued.delete(id)
    if (!this.sending.has(id)) this.errors.delete(id)
    this.persist()
    this.emit()
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }

  private schedule(id: string): Promise<SaveResult> {
    const prev = this.tails.get(id) ?? Promise.resolve(undefined)
    const next = prev.catch(() => undefined).then((last) =>
      this.queued.has(id) ? this.flush(id) : last ?? { kind: 'pending' as const, reason: 'Modification abandonnée.' })
    this.tails.set(id, next)
    void next.finally(() => { if (this.tails.get(id) === next) this.tails.delete(id) })
    return next
  }

  private async flush(id: string): Promise<SaveResult> {
    const change = this.queued.get(id) as LinearChange
    this.queued.delete(id)
    this.sending.set(id, change)
    let result: SaveResult
    try {
      result = await this.send(id, change)
    } catch (e) {
      result = { kind: 'pending', reason: reasonOf(e) }
    }
    this.sending.delete(id)
    const later = this.queued.get(id)
    if (result.kind === 'sent') {
      if (later) {
        // a description edited from the text just sent is now based on Linear's own text (Linear re-serializes on save)
        if (later.description && change.description && later.description.base === change.description.text) {
          this.queued.set(id, { ...later, description: { base: result.issue.description, text: later.description.text } })
        }
      } else this.errors.delete(id)
    } else {
      this.queued.set(id, merge(change, later))
      this.errors.set(id, result.kind === 'conflict' ? CONFLICT_REASON : result.reason)
    }
    this.persist()
    this.emit()
    return result
  }

  private async send(id: string, c: LinearChange): Promise<SaveResult> {
    const args: Record<string, unknown> = {}
    if (c.title !== undefined) args.title = c.title
    if (c.statusId !== undefined) args.state = c.statusId
    if (c.priority !== undefined) args.priority = PRIORITY_VALUE[c.priority]
    if (c.labels !== undefined) args.labels = c.labels
    if (c.assigneeId !== undefined) args.assignee = c.assigneeId
    const d = c.description
    if (!d) return { kind: 'sent', issue: await this.client.save(id, args) }

    for (let attempt = 0; ; attempt++) {
      const remote = await this.client.issueBrief(id)
      const r = rebase(d.base, d.text, remote.description)
      if (r.kind === 'conflict') return { kind: 'conflict', field: 'description', remote: r.remote, mine: d.text }
      const send = { ...args }
      if (r.ops.length > 0) send.patch = r.ops
      if (Object.keys(send).length === 0) return { kind: 'sent', issue: remote }
      try {
        return { kind: 'sent', issue: await this.client.save(id, send) }
      } catch (e) {
        if (!isPatchFailure(e) || !send.patch) throw e
        // an anchor vanished between the read and the send: re-read once, then it is a conflict
        if (attempt >= 1) return { kind: 'conflict', field: 'description', remote: remote.description, mine: d.text }
      }
    }
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  private load(): Entry[] {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return [] // no file yet
    }
    try {
      const v = JSON.parse(text) as unknown
      if (!isRecord(v) || !Array.isArray(v.entries)) throw new Error('shape')
      return v.entries.map((e) => {
        if (!isRecord(e) || typeof e.id !== 'string' || !isRecord(e.change)) throw new Error('entry')
        return { id: e.id, change: e.change as LinearChange, error: typeof e.error === 'string' ? e.error : '' }
      })
    } catch {
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* keep going empty */ }
      return []
    }
  }

  /** Atomic write (tmp + rename), owner-only. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ entries: this.pending() }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      console.error('linear-pending: write failed', e)
    }
  }
}
