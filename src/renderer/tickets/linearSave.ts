import { UNCERTAIN_REASON, sameDescription, type LinearChange, type LinearField, type LinearIssue, type PendingEdit, type SaveResult } from '../../shared/linear'

export type TextKey = 'title' | 'description'

export type SideChange = Omit<LinearChange, 'title' | 'description'>
type SideKey = keyof SideChange

export interface LinearSaver {
  /** Status, priority, labels, assignee: sent now, and shown (`side()`) until their latest send answers. */
  field(c: SideChange): void
  /** Side values chosen and not answered yet, or answered `pending` (main holds them) and not read back since. */
  side(): SideChange
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
  /** Bumped by every send and every answer: a read taken before a change must not undo it. */
  generation(): number
  /**
   * A read of the issue; `pending` (main's queue for it) wins over Linear's text. `readAt`: `generation()` when the
   * read started. `kept`: stale read or text being typed, the text fields stay. `same`: main's held description is
   * Linear's once normalized; the caller discards it.
   */
  reset(issue: Pick<LinearIssue, 'title' | 'description'>, pending?: PendingEdit, readAt?: number): 'applied' | 'kept' | 'same'
  /** Main's copy of `fields` was discarded: they take Linear's value, the others stay as they are. */
  resetFields(issue: Pick<LinearIssue, 'title' | 'description'>, fields: readonly LinearField[]): void
  /** `fresh`: no later send has answered before this one; an older answer must not be shown over a newer one. */
  onResult(l: (r: SaveResult, fresh: boolean) => void): () => void
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
  const listeners = new Set<(r: SaveResult, fresh: boolean) => void>()
  let gen = 0
  /** Order of the sends, and the latest one answered. */
  let sends = 0
  let lastAnswered = 0
  /** Side values shown over the issue: the latest send per key, and whether it answered `pending` (settled). */
  const side: SideChange = {}
  const sideSeq: Partial<Record<SideKey, number>> = {}
  const settled = new Set<SideKey>()

  const isDirty = (k: TextKey): boolean => cur[k] !== committed[k]
  const answered = (n: number): boolean => {
    gen++
    const fresh = n > lastAnswered
    if (fresh) lastAnswered = n
    return fresh
  }
  const emit = (r: SaveResult, fresh: boolean): void => { for (const l of listeners) l(r, fresh) }

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
    const n = ++sends
    gen++
    let r: SaveResult
    try { r = await send(c) } catch (e) {
      r = { kind: 'pending', reason: message(e) }
      emit(r, answered(n))
      return r
    }
    const fresh = answered(n)
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
    if (fresh) adopt(r.issue, keys)
    emit(r, fresh)
    return r
  }

  const queue = (fn: () => Promise<SaveResult | null>): Promise<SaveResult | null> => {
    const p = chain.then(fn)
    chain = p.catch(() => undefined)
    return p
  }

  const dropSide = (keys: readonly string[]): void => {
    for (const k of keys as SideKey[]) { delete side[k]; delete sideSeq[k]; settled.delete(k) }
  }

  return {
    field(c) {
      const n = ++sends
      gen++
      const keys = Object.keys(c) as SideKey[]
      Object.assign(side, c)
      for (const k of keys) { sideSeq[k] = n; settled.delete(k) }
      const settle = (r: SaveResult): void => {
        for (const k of keys) {
          if (sideSeq[k] !== n) continue
          if (r.kind === 'sent') dropSide([k])
          else settled.add(k)
        }
      }
      void send(c).then(
        (r) => { const fresh = answered(n); settle(r); if (fresh) adopt(r.issue, []); emit(r, fresh) },
        (e: unknown) => { const r: SaveResult = { kind: 'pending', reason: message(e) }; const fresh = answered(n); settle(r); emit(r, fresh) }
      )
    },
    side: () => ({ ...side }),
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
      gen++
    },
    generation: () => gen,
    reset(answer, pending, readAt) {
      if (readAt !== undefined && readAt !== gen) return 'kept'
      // A fresh read: what main holds now shows through the pending entry.
      dropSide([...settled])
      if (KEYS.some(isDirty)) return 'kept'
      const p = pending?.change
      cur.title = committed.title = p?.title ?? answer.title
      cur.description = committed.description = p?.description?.text ?? answer.description
      base = p?.description?.base ?? answer.description
      held.title = p?.title !== undefined
      held.description = p?.description !== undefined
      conflict = p?.description && (pending?.held.description !== undefined || pending?.uncertain)
        ? { remote: answer.description, mine: p.description.text }
        : null
      if (conflict && sameDescription(conflict.mine, conflict.remote)) {
        cur.description = committed.description = base = answer.description
        held.description = false
        conflict = null
        return 'same'
      }
      return 'applied'
    },
    resetFields(answer, fields) {
      for (const k of KEYS) {
        if (!fields.includes(k)) continue
        cur[k] = committed[k] = answer[k]
        held[k] = false
        if (k === 'description') { base = answer.description; conflict = null }
      }
      dropSide(fields)
      gen++
    },
    onResult(l) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    }
  }
}

/** Why the description shows both versions: main's held reason, else an unchecked uncertain resend, else a colleague. */
export function conflictHint(entry: PendingEdit | undefined): string {
  if (entry?.held.description) return entry.held.description
  if (entry?.uncertain) return UNCERTAIN_REASON
  return 'Un collègue a modifié le même passage de la description.'
}

/** The Linear editors' savers: open ones, and closed ones whose text could not be sent. Quit asks while one holds text. */
const open = new Set<LinearSaver>()
/**
 * Closed editors' savers still holding text, by issue id, oldest first: the next editor of the issue takes the newest,
 * the others wait their turn. None is ever dropped, so every one counted at quit can be reopened.
 */
const stranded = new Map<string, LinearSaver[]>()
/** Comments being typed and not posted, by issue id: kept when the editor closes, counted at quit. */
const comments = new Map<string, string>()
const watchers = new Set<() => void>()

export function notifyLinearSavers(): void { for (const w of watchers) w() }

const unstrand = (id: string, s: LinearSaver): void => {
  const left = (stranded.get(id) ?? []).filter((x) => x !== s)
  if (left.length > 0) stranded.set(id, left)
  else stranded.delete(id)
}

/** The saver an editor of `id` should use: the newest one a closed editor left with unsent text, or a new one. No side effect. */
export function linearSaverFor(id: string, make: () => LinearSaver): LinearSaver {
  return stranded.get(id)?.at(-1) ?? make()
}

/** Counts `s`, the saver of an open editor of `id`. */
export function trackLinearSaver(id: string, s: LinearSaver): void {
  unstrand(id, s)
  open.add(s)
  notifyLinearSavers()
}

export function openLinearSaver(id: string, make: () => LinearSaver): LinearSaver {
  const s = linearSaverFor(id, make)
  trackLinearSaver(id, s)
  return s
}

/**
 * The editor of `id` closed: sends what it holds. Text that could not be sent stays counted and goes to the next
 * editor of the issue. `closed` false after the send: the editor came back (StrictMode remount).
 */
export async function closeLinearSaver(id: string, s: LinearSaver, closed: () => boolean): Promise<void> {
  await s.commit().catch(() => null)
  if (!closed()) return
  if (s.unsent()) {
    unstrand(id, s)
    stranded.set(id, [...(stranded.get(id) ?? []), s])
  } else {
    unstrand(id, s)
    open.delete(s)
  }
  notifyLinearSavers()
}

/** The comment being typed on `id` ('' when none). */
export const commentDraft = (id: string): string => comments.get(id) ?? ''

export function setCommentDraft(id: string, text: string): void {
  if (text === '') comments.delete(id)
  else comments.set(id, text)
  notifyLinearSavers()
}

/**
 * Hands the title and description typed in every Linear editor, open or closed with unsent text, to main (sent, or kept
 * in its on-disk queue); true when nothing is left. Comments are not posted: posting is Bastien's explicit action.
 */
export async function flushLinearSavers(): Promise<boolean> {
  const all = new Set([...open, ...[...stranded.values()].flat()])
  await Promise.all([...all].map((s) => s.commit().catch(() => null)))
  notifyLinearSavers()
  return [...all].every((s) => !s.unsent())
}

/** Comments typed and not posted: no automatic save keeps them. */
export const unsavedLinearComments = (): number => [...comments.values()].filter((t) => t.trim() !== '').length

/** Linear editors' text not handed over, and comments typed and not posted. */
export const unsavedLinear = (): number =>
  [...open].filter((s) => s.unsent()).length + unsavedLinearComments()

export function onLinearSaversChange(l: () => void): () => void {
  watchers.add(l)
  return () => { watchers.delete(l) }
}
