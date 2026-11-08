import type { LinearChange, LinearIssue, PendingEdit, SaveResult } from '../../shared/linear'

export type TextKey = 'title' | 'description'

export interface LinearSaver {
  /** Status, priority, labels, assignee: sent now. */
  field(c: Omit<LinearChange, 'title' | 'description'>): void
  /** Typing in the title or the description: kept, never sent from here. */
  text(k: TextKey, v: string): void
  /** Leaving the field (`k`) or closing the editor (both): sends what was typed since the last commit, once. */
  commit(k?: TextKey): Promise<SaveResult | null>
  /** Text typed and not handed to Linear nor to main's queue, a conflict's own text included. */
  dirty(): boolean
  /** What quitting would lose: dirty, minus the description main already holds in a conflict. */
  unsent(): boolean
  /** What the field shows. */
  value(k: TextKey): string
  /** The description that a colleague changed on the same passage; nothing more is sent for it until resolved. */
  conflict(): { remote: string; mine: string } | null
  /** « Garder la mienne »: Bastien's text, over Linear's version. */
  keepMine(): Promise<SaveResult | null>
  /** « Prendre celle de Linear »: the description becomes Linear's (main's held copy is discarded by the caller). */
  takeTheirs(): void
  /** A fresh read of the issue; `pending` (main's queue for it) wins over Linear's text. */
  reset(issue: Pick<LinearIssue, 'title' | 'description'>, pending?: PendingEdit): void
  onResult(l: (r: SaveResult) => void): () => void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const KEYS: TextKey[] = ['title', 'description']

/**
 * Title and description of a Linear editor: kept while typed, sent on commit. The description goes as `{ base, text }`,
 * `base` being the text last read from Linear or Linear's answer to the last send (Linear rewrites Markdown: never the
 * text sent). Main computes the patch, rebases it and queues what does not go through.
 */
export function createLinearSaver(
  _id: string,
  issue: Pick<LinearIssue, 'title' | 'description'>,
  send: (c: LinearChange) => Promise<SaveResult>
): LinearSaver {
  /** What the fields show. */
  const cur = { title: issue.title, description: issue.description }
  /** The last value handed over (Linear's, or queued by main): `cur` differs from it = dirty. */
  const committed = { ...cur }
  /** The description patch base. */
  let base = issue.description
  /** Fields main holds in its queue: an answer about another field leaves them alone. */
  const held = { title: false, description: false }
  let conflict: { remote: string; mine: string } | null = null
  let chain: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(r: SaveResult) => void>()

  const isDirty = (k: TextKey): boolean => cur[k] !== committed[k]
  const emit = (r: SaveResult): void => { for (const l of listeners) l(r) }

  /** Linear's answer for the fields not sent nor being edited. */
  const adopt = (answer: LinearIssue | undefined, sent: TextKey[]): void => {
    if (!answer) return
    for (const k of KEYS) {
      if (sent.includes(k) || isDirty(k) || held[k] || (k === 'description' && conflict)) continue
      cur[k] = committed[k] = answer[k]
      if (k === 'description') base = answer.description
    }
  }

  const deliver = async (keys: TextKey[], c: LinearChange): Promise<SaveResult> => {
    const sentValues = { ...cur }
    let r: SaveResult
    try { r = await send(c) } catch (e) { r = { kind: 'pending', reason: message(e) }; emit(r); return r }
    if (r.kind === 'sent') {
      for (const k of keys) {
        held[k] = false
        if (cur[k] === sentValues[k]) cur[k] = r.issue[k]
        committed[k] = r.issue[k]
      }
      if (keys.includes('description')) { base = r.issue.description; conflict = null }
    } else if (r.kind === 'pending') {
      // Main queued them (with their base): a next edit goes with the same base.
      for (const k of keys) { held[k] = true; committed[k] = sentValues[k] }
    } else {
      for (const k of keys.filter((x) => x !== 'description')) { held[k] = true; committed[k] = sentValues[k] }
      held.description = true
      conflict = { remote: r.remote, mine: r.mine }
    }
    adopt(r.issue, keys)
    emit(r)
    return r
  }

  const queue = (fn: () => Promise<SaveResult | null>): Promise<SaveResult | null> => {
    const p = chain.then(fn)
    chain = p.catch(() => undefined)
    return p
  }

  return {
    field(c) {
      void send(c).then(
        (r) => { adopt(r.issue, []); emit(r) },
        (e: unknown) => emit({ kind: 'pending', reason: message(e) })
      )
    },
    text(k, v) { cur[k] = v },
    commit(k) {
      return queue(async () => {
        if ((!k || k === 'title') && cur.title.trim() === '') cur.title = committed.title
        const keys = (k ? [k] : KEYS).filter((x) => isDirty(x) && !(x === 'description' && conflict))
        if (keys.length === 0) return null
        const c: LinearChange = {}
        if (keys.includes('title')) c.title = cur.title
        if (keys.includes('description')) c.description = { base, text: cur.description }
        return deliver(keys, c)
      })
    },
    dirty: () => KEYS.some(isDirty),
    unsent: () => isDirty('title') || (isDirty('description') && !conflict),
    value: (k) => cur[k],
    conflict: () => conflict,
    keepMine() {
      return queue(async () => {
        if (!conflict) return null
        base = conflict.remote
        conflict = null
        return deliver(['description'], { description: { base, text: cur.description } })
      })
    },
    takeTheirs() {
      if (!conflict) return
      cur.description = committed.description = base = conflict.remote
      held.description = false
      conflict = null
    },
    reset(answer, pending) {
      const p = pending?.change
      cur.title = committed.title = p?.title ?? answer.title
      cur.description = committed.description = p?.description?.text ?? answer.description
      base = p?.description?.base ?? answer.description
      held.title = p?.title !== undefined
      held.description = p?.description !== undefined
      conflict = p?.description && (pending?.held.description !== undefined || pending?.uncertain)
        ? { remote: answer.description, mine: p.description.text }
        : null
    },
    onResult(l) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    }
  }
}

/** The open Linear editors' savers: quitting asks while one holds text not handed over. */
const open = new Set<LinearSaver>()
const watchers = new Set<() => void>()

export function notifyLinearSavers(): void { for (const w of watchers) w() }

export function trackLinearSaver(s: LinearSaver): () => void {
  open.add(s)
  notifyLinearSavers()
  return () => { open.delete(s); notifyLinearSavers() }
}

export const unsavedLinear = (): number => [...open].filter((s) => s.unsent()).length

export function onLinearSaversChange(l: () => void): () => void {
  watchers.add(l)
  return () => { watchers.delete(l) }
}
