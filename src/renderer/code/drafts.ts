import type { StashedBuffer } from '../../shared/update'
/** An unsaved buffer and the version of the file it was typed over. */
export interface Draft { text: string; version: string }

const drafts = new Map<string, Draft>()
const key = (cwd: string, path: string): string => `${cwd}\0${path}`
const listeners = new Set<() => void>()
const changed = (): void => { listeners.forEach((cb) => cb()) }

/** Edits outlive the view showing them: switching view, worktree, file or branch must not lose typing. */
export const getDraft = (cwd: string, path: string): Draft | undefined => drafts.get(key(cwd, path))
export const setDraft = (cwd: string, path: string, d: Draft): void => { drafts.set(key(cwd, path), d); changed() }
export const dropDraft = (cwd: string, path: string): void => { if (drafts.delete(key(cwd, path))) changed() }
/** The worktree is gone, and the files these were typed over with it. */
export function dropDrafts(cwd: string): void {
  for (const k of [...drafts.keys()]) if (k.startsWith(`${cwd}\0`)) drafts.delete(k)
  changed()
}
export const draftCount = (): number => drafts.size
export function onDraftsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** What the Code view showed for a worktree, to show it again after a visit to Sessions. */
export interface Shown { selected: string | null; mode: 'code' | 'diff'; scope: 'all' | 'changed' }
const shown = new Map<string, Shown>()
export const getShown = (cwd: string): Shown | undefined => shown.get(cwd)
export const setShown = (cwd: string, s: Shown): void => { shown.set(cwd, s) }

/** Every unsaved buffer, for the update stash. */
export function allDrafts(): StashedBuffer[] {
  return [...drafts].map(([k, d]) => {
    const [cwd, path] = k.split('\0')
    return { cwd, path, text: d.text, version: d.version }
  })
}
