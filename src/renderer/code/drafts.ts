/** An unsaved buffer and the version of the file it was typed over. */
export interface Draft { text: string; version: string }

const drafts = new Map<string, Draft>()
const key = (cwd: string, path: string): string => `${cwd}\0${path}`

/** Edits outlive the view showing them: switching view, worktree, file or branch must not lose typing. */
export const getDraft = (cwd: string, path: string): Draft | undefined => drafts.get(key(cwd, path))
export const setDraft = (cwd: string, path: string, d: Draft): void => { drafts.set(key(cwd, path), d) }
export const dropDraft = (cwd: string, path: string): void => { drafts.delete(key(cwd, path)) }

/** What the Code view showed for a worktree, to show it again after a visit to Sessions. */
export interface Shown { selected: string | null; mode: 'code' | 'diff'; scope: 'all' | 'changed' }
const shown = new Map<string, Shown>()
export const getShown = (cwd: string): Shown | undefined => shown.get(cwd)
export const setShown = (cwd: string, s: Shown): void => { shown.set(cwd, s) }
