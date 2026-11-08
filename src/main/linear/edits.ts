import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LinearChange, LinearField, LinearIssue, PendingEdit, SaveResult } from '../../shared/linear'
import { PRIORITIES, type TicketPriority } from '../../shared/tickets'
import { LinearExpiredError, LinearNotConnectedError, type LinearClient } from './client'
import { diffToPatch, rebase, sameDescription, type PatchOp } from './descriptionPatch'
import { LinearError, LinearFormatError } from './parse'

export type { LinearChange, LinearField, PendingEdit, SaveResult } from '../../shared/linear'

type Client = Pick<LinearClient, 'issueBrief' | 'save'>

const PRIORITY_VALUE: Record<TicketPriority, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }

const PLAIN: { field: Exclude<LinearField, 'description'>; arg: string; value: (c: LinearChange) => unknown }[] = [
  { field: 'title', arg: 'title', value: (c) => c.title },
  { field: 'statusId', arg: 'state', value: (c) => c.statusId },
  { field: 'priority', arg: 'priority', value: (c) => (c.priority === undefined ? undefined : PRIORITY_VALUE[c.priority]) },
  { field: 'labels', arg: 'labels', value: (c) => c.labels },
  { field: 'assigneeId', arg: 'assignee', value: (c) => c.assigneeId },
]
const FIELDS: LinearField[] = ['title', 'description', 'statusId', 'priority', 'labels', 'assigneeId']

/**
 * `newer` on top of `older`, key by key. A description edited from the queued text (`newer.base === older.text`)
 * keeps the older base, the one Linear gave; any other base replaces the queued description (the newer edit was made
 * from that text, so it is taken as is). Known limit: a newer edit made from an older text than the queued one
 * replaces the queued description; the renderer is expected to edit from the queued text.
 */
function merge(older: LinearChange | undefined, newer: LinearChange | undefined): LinearChange {
  const out: LinearChange = { ...older, ...newer }
  if (older?.description && newer?.description && newer.description.base === older.description.text) {
    out.description = { base: older.description.base, text: newer.description.text }
  }
  return out
}

function only(c: LinearChange, keep: (f: LinearField) => boolean): LinearChange {
  const out: Record<string, unknown> = {}
  for (const f of FIELDS) if (c[f] !== undefined && keep(f)) out[f] = c[f]
  return out as LinearChange
}

const fieldsOf = (c: LinearChange): LinearField[] => FIELDS.filter((f) => c[f] !== undefined)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Linear's own text for a failed patch (tests/fixtures/linear/README.md): nothing was saved. */
const PATCH_FAILED = 'Error: Patch failed, nothing was saved.'
const isPatchFailure = (e: unknown): boolean => e instanceof LinearError && e.message.startsWith(PATCH_FAILED)

/** The request was refused before reaching Linear, or Linear refused it: nothing was saved. */
const notApplied = (e: unknown): boolean =>
  e instanceof LinearExpiredError || e instanceof LinearNotConnectedError || e instanceof LinearError

function reasonOf(e: unknown): string {
  if (e instanceof LinearExpiredError || e instanceof LinearNotConnectedError || e instanceof LinearFormatError) return e.message
  if (e instanceof LinearError) return `Linear a refusé la modification : ${e.message}`
  return `Linear injoignable : ${e instanceof Error ? e.message : String(e)}`
}

const CONFLICT_REASON = 'Conflit : la description a aussi été modifiée dans Linear au même endroit.'

function validChange(v: unknown): v is LinearChange {
  if (!isRecord(v)) return false
  for (const [k, x] of Object.entries(v)) {
    switch (k) {
      case 'title': case 'statusId': if (typeof x !== 'string') return false; break
      case 'description': if (!isRecord(x) || typeof x.base !== 'string' || typeof x.text !== 'string') return false; break
      case 'priority': if (!PRIORITIES.includes(x as TicketPriority)) return false; break
      case 'labels': if (!Array.isArray(x) || !x.every((l) => typeof l === 'string')) return false; break
      case 'assigneeId': if (x !== null && typeof x !== 'string') return false; break
      default: return false
    }
  }
  return true
}

/** What one send did. */
interface Outcome {
  done: LinearField[]
  held: Partial<Record<LinearField, string>>
  /** Answer of the last successful save. */
  issue?: LinearIssue
  /** Last read of the issue. */
  read?: LinearIssue
  conflict?: { remote: string; mine: string }
  /** The description Linear holds now, when the description was saved (or found already there). */
  descriptionNow?: string
}

/** The send stopped on a failure where Linear could not be asked (or answered nothing usable). */
class SendFailure extends Error {
  constructor(readonly reason: string, readonly uncertain: boolean, readonly partial: Outcome) {
    super(reason)
  }
}

/**
 * Queue of Bastien's edits to Linear issues. Every edit is written to `file` before it is sent and removed once Linear
 * saved it, so an unsent edit survives a failure or a restart. Descriptions go out as `patch` ops rebased on Linear's
 * current text, so a colleague's edit elsewhere is kept and an edit of the same passage is a conflict, never an
 * overwrite. A stuck field (conflict, refusal) is held alone: the other fields go. A patch whose answer was lost is
 * never resent blindly. One send at a time per issue; a save arriving meanwhile is merged and sent after.
 */
export class LinearEdits {
  /** Waiting to be sent, held, or failed. */
  private readonly queued = new Map<string, LinearChange>()
  /** Being sent right now. */
  private readonly sending = new Map<string, LinearChange>()
  private readonly errors = new Map<string, string>()
  private readonly held = new Map<string, Partial<Record<LinearField, string>>>()
  private readonly uncertain = new Set<string>()
  /** Discards asked during a send, applied once it settles; `null` = every field. */
  private readonly discards = new Map<string, Set<LinearField> | null>()
  private readonly tails = new Map<string, Promise<SaveResult | undefined>>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly file: string, private readonly client: Client) {
    for (const e of this.load()) {
      this.queued.set(e.id, e.change)
      if (e.error) this.errors.set(e.id, e.error)
      if (Object.keys(e.held).length > 0) this.held.set(e.id, e.held)
      if (e.uncertain && e.change.description) this.uncertain.add(e.id)
    }
  }

  /** Queues `c` for `id` and sends it (after any send already in flight for `id`). A changed field is no longer held. */
  save(id: string, c: LinearChange): Promise<SaveResult> {
    this.queued.set(id, merge(this.queued.get(id), c))
    const h = this.held.get(id)
    if (h) for (const f of fieldsOf(c)) delete h[f]
    this.persist()
    this.emit()
    return this.schedule(id, false)
  }

  pending(): PendingEdit[] {
    const ids = new Set([...this.sending.keys(), ...this.queued.keys()])
    return [...ids].map((id) => ({
      id,
      change: structuredClone(merge(this.sending.get(id), this.queued.get(id))),
      error: this.errors.get(id) ?? '',
      held: { ...this.held.get(id) },
      uncertain: this.uncertain.has(id),
    }))
  }

  /** Sends every queued edit again, held fields included. */
  async retryAll(): Promise<void> {
    await Promise.all([...this.queued.keys()].map((id) => this.schedule(id, true)))
  }

  /**
   * Drops `fields` (every field when omitted) of the queued edit of `id`. Only on Bastien's explicit choice.
   * A send already in flight is not cancelled; the discard applies to what it leaves unsent.
   */
  discard(id: string, fields?: LinearField[]): void {
    if (this.sending.has(id)) {
      const prev = this.discards.get(id)
      this.discards.set(id, fields === undefined || prev === null ? null : new Set([...(prev ?? []), ...fields]))
    }
    this.drop(id, fields === undefined ? null : new Set(fields))
    this.persist()
    this.emit()
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }

  private drop(id: string, fields: Set<LinearField> | null): void {
    const q = this.queued.get(id)
    const rest = q ? only(q, (f) => fields !== null && !fields.has(f)) : {}
    const h = this.held.get(id)
    if (h) for (const f of FIELDS) if (fields === null || fields.has(f)) delete h[f]
    if (fields === null || fields.has('description')) this.uncertain.delete(id)
    if (fieldsOf(rest).length > 0) this.queued.set(id, rest)
    else {
      this.queued.delete(id)
      if (!this.sending.has(id)) {
        this.errors.delete(id)
        this.held.delete(id)
        this.uncertain.delete(id)
      }
    }
  }

  private schedule(id: string, includeHeld: boolean): Promise<SaveResult> {
    const prev = this.tails.get(id) ?? Promise.resolve(undefined)
    const next = prev.catch(() => undefined).then((last) =>
      this.queued.has(id) ? this.flush(id, includeHeld) : last ?? { kind: 'pending' as const, reason: 'Modification abandonnée.' })
    this.tails.set(id, next)
    void next.finally(() => { if (this.tails.get(id) === next) this.tails.delete(id) })
    return next
  }

  private async flush(id: string, includeHeld: boolean): Promise<SaveResult> {
    const all = this.queued.get(id) as LinearChange
    const heldNow = this.held.get(id) ?? {}
    const change = includeHeld ? all : only(all, (f) => heldNow[f] === undefined)
    const left = only(all, (f) => change[f] === undefined)
    if (fieldsOf(change).length === 0) {
      return { kind: 'pending', reason: Object.values(heldNow)[0] ?? 'Modification en attente.' }
    }
    if (fieldsOf(left).length > 0) this.queued.set(id, left)
    else this.queued.delete(id)
    this.sending.set(id, change)
    this.persist() // records the fields in flight

    let out: Outcome
    let failure: SendFailure | null = null
    try {
      out = await this.send(id, change, this.uncertain.has(id))
    } catch (e) {
      failure = e instanceof SendFailure ? e : new SendFailure(reasonOf(e), false, { done: [], held: {} })
      out = failure.partial
    }
    this.sending.delete(id)

    const done = new Set(out.done)
    const unsent = only(change, (f) => !done.has(f))
    const later = this.queued.get(id)
    let next = merge(unsent, later)
    if (later?.description && change.description && later.description.base === change.description.text
      && out.descriptionNow !== undefined) {
      // edited from the text just saved: now based on Linear's own text (Linear re-serializes on save)
      next = { ...next, description: { base: out.descriptionNow, text: later.description.text } }
    }
    const h = { ...this.held.get(id) }
    for (const f of done) delete h[f]
    for (const [f, why] of Object.entries(out.held)) if (later?.[f as LinearField] === undefined) h[f as LinearField] = why
    this.held.set(id, h)
    if (done.has('description') && !later?.description) this.uncertain.delete(id)
    if (failure?.uncertain) this.uncertain.add(id)
    if (failure) this.errors.set(id, failure.reason)
    else this.errors.delete(id)
    this.queued.set(id, next)
    const discard = this.discards.get(id)
    this.discards.delete(id)
    this.drop(id, discard === undefined ? new Set() : discard)
    this.persist()
    this.emit()

    if (failure) return { kind: 'pending', reason: failure.reason, ...(out.issue ? { issue: out.issue } : {}) }
    if (out.conflict) return { kind: 'conflict', field: 'description', ...out.conflict, ...(out.issue ? { issue: out.issue } : {}) }
    const why = Object.values(out.held)[0]
    if (why !== undefined) return { kind: 'pending', reason: why, ...(out.issue ? { issue: out.issue } : {}) }
    return { kind: 'sent', issue: out.issue ?? out.read ?? await this.client.issueBrief(id) }
  }

  /**
   * Sends `c`. Description: read Linear's text, then patch, already there, or conflict (held). A failed patch re-reads
   * once. A field Linear refuses is held alone: the others are sent one by one. Throws `SendFailure` when Linear could
   * not be asked; `uncertain` when a patch may have been applied.
   */
  private async send(id: string, c: LinearChange, uncertain: boolean): Promise<Outcome> {
    const out: Outcome = { done: [], held: {} }
    const parts = new Map<LinearField, Record<string, unknown>>()
    for (const p of PLAIN) {
      const v = p.value(c)
      if (v !== undefined) parts.set(p.field, { [p.arg]: v })
    }
    const d = c.description
    const conflict = (remote: string) => {
      out.held.description = CONFLICT_REASON
      out.conflict = { remote, mine: d?.text ?? '' }
      parts.delete('description')
    }
    const plan = async (): Promise<void> => {
      if (!d) return
      let remote: LinearIssue
      try {
        remote = await this.client.issueBrief(id)
      } catch (e) {
        throw new SendFailure(reasonOf(e), false, out)
      }
      out.read = remote
      const ops = decide(d, remote.description, uncertain)
      if (ops === 'conflict') conflict(remote.description)
      else if (ops.length === 0) {
        out.done.push('description')
        out.descriptionNow = remote.description
        parts.delete('description')
      } else parts.set('description', { patch: ops, remote: remote.description })
    }
    const argsOf = (fs: [LinearField, Record<string, unknown>][]): Record<string, unknown> => {
      const args: Record<string, unknown> = {}
      for (const [, a] of fs) for (const [k, v] of Object.entries(a)) if (k !== 'remote') args[k] = v
      return args
    }
    const saved = (fs: LinearField[], issue: LinearIssue) => {
      out.issue = issue
      out.done.push(...fs)
      if (fs.includes('description')) out.descriptionNow = issue.description
      for (const f of fs) parts.delete(f)
    }
    const failed = (e: unknown, fs: LinearField[]): SendFailure =>
      new SendFailure(reasonOf(e), fs.includes('description') && !notApplied(e), out)

    await plan()
    let reread = false
    while (parts.size > 0) {
      const entries = [...parts]
      const fs = entries.map(([f]) => f)
      try {
        saved(fs, await this.client.save(id, argsOf(entries)))
        break
      } catch (e) {
        if (isPatchFailure(e) && parts.has('description')) {
          // an anchor vanished between the read and the send: nothing was saved; re-read once, then it is a conflict
          if (!reread) { reread = true; await plan() } else conflict(String(parts.get('description')?.remote ?? ''))
          continue
        }
        if (!(e instanceof LinearError)) throw failed(e, fs)
        if (entries.length === 1) {
          out.held[fs[0]] = reasonOf(e)
          parts.clear()
          break
        }
        // Linear refused the whole save: find the refused field(s), sending one field at a time
        for (const [f, a] of entries) {
          try {
            saved([f], await this.client.save(id, argsOf([[f, a]])))
          } catch (e2) {
            if (!(e2 instanceof LinearError)) throw failed(e2, [f])
            if (f === 'description' && isPatchFailure(e2)) conflict(String(a.remote ?? ''))
            else out.held[f] = reasonOf(e2)
            parts.delete(f)
          }
        }
      }
    }
    return out
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  private setAside(): void {
    try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* keep going */ }
  }

  /** The stored queue; an unreadable file, or its malformed entries, are kept aside in `<file>.corrupt-<ms>`. */
  private load(): (PendingEdit & { sending: LinearField[] })[] {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return [] // no file yet
    }
    let v: unknown
    try { v = JSON.parse(text) } catch { v = null }
    if (!isRecord(v) || !Array.isArray(v.entries)) {
      this.setAside()
      return []
    }
    const good: (PendingEdit & { sending: LinearField[] })[] = []
    let bad = false
    for (const e of v.entries) {
      if (!isRecord(e) || typeof e.id !== 'string' || !validChange(e.change)) { bad = true; continue }
      const held: Partial<Record<LinearField, string>> = {}
      if (isRecord(e.held)) for (const f of FIELDS) if (typeof e.held[f] === 'string') held[f] = e.held[f] as string
      const sending = Array.isArray(e.sending) ? (e.sending.filter((f) => FIELDS.includes(f as LinearField)) as LinearField[]) : []
      good.push({
        id: e.id,
        change: e.change,
        error: typeof e.error === 'string' ? e.error : '',
        held,
        // a description in flight when the app stopped may have been applied
        uncertain: e.uncertain === true || sending.includes('description'),
        sending,
      })
    }
    if (bad) this.setAside() // the good entries are written back on the next save
    return good
  }

  /** Atomic write (tmp + rename), owner-only. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      const entries = this.pending().map((p) => ({ ...p, sending: fieldsOf(this.sending.get(p.id) ?? {}) }))
      writeFileSync(tmp, JSON.stringify({ entries }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      console.error('linear-pending: write failed', e)
    }
  }
}

/**
 * Ops to send for `d` on Linear's text `remote`, `[]` when Linear already has it, or a conflict. An uncertain edit
 * (a previous patch may have been applied) is only patched when Linear still has the base: it is already there when
 * Linear's text equals mine once normalised, and anything else is Bastien's call.
 */
function decide(d: { base: string; text: string }, remote: string, uncertain: boolean): PatchOp[] | 'conflict' {
  if (uncertain) {
    if (remote === d.base) return diffToPatch(d.base, d.text)
    return sameDescription(remote, d.text) ? [] : 'conflict'
  }
  const r = rebase(d.base, d.text, remote)
  return r.kind === 'conflict' ? 'conflict' : r.ops
}
