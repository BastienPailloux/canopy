/** How long Monaco may compute a diff: the content comes from the repository, so nothing runs unbounded. */
export const DIFF_TIMEOUT_MS = 30_000
/** Past this, a diff that never answered counts as abandoned: the worker may have died without a word. */
export const DIFF_WATCHDOG_MS = DIFF_TIMEOUT_MS + 5_000
/** A blank pane must not read as "no changes" for long. */
export const DIFF_SLOW_MS = 1_000

export type DiffStatus = 'complete' | 'computing' | 'abandoned'

/** What Monaco said of a diff. `lineChanges` is null when it has no result. */
export interface DiffResult { lineChanges: unknown[] | null; quitEarly: boolean | undefined }

/** Whether what is shown may be partial or wrong: Monaco stopped early, or never gave a result. */
export const diffAbandoned = (r: DiffResult): boolean => r.lineChanges === null || r.quitEarly === true
