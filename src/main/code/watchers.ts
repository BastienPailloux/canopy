import { listWorktrees } from '../git/worktrees'
import { watchWorktree } from './files'

const watchers = new Map<string, () => void>()

let syncing: Promise<unknown> = Promise.resolve()

/**
 * Watches exactly the worktrees `repo` lists now: others, removed or from a repo left behind, are stopped and reported to `onStopped`.
 * Calls run one after the other: a slow listing must not win over the repo opened after it.
 */
export function syncWatchers(
  repo: string, onChange: (cwd: string) => void, onError: (cwd: string, error: Error) => void, onStopped?: (cwd: string) => void
): Promise<void> {
  const run = syncing.then(() => sync(repo, onChange, onError, onStopped))
  syncing = run.catch(() => undefined)
  return run
}

async function sync(
  repo: string, onChange: (cwd: string) => void, onError: (cwd: string, error: Error) => void, onStopped?: (cwd: string) => void
): Promise<void> {
  const listed = new Set((await listWorktrees(repo)).map((w) => w.path))
  for (const [path, stop] of watchers) {
    if (listed.has(path)) continue
    stop()
    watchers.delete(path)
    onStopped?.(path)
  }
  for (const path of listed) {
    if (!watchers.has(path)) watchers.set(path, watchWorktree(path, () => onChange(path), undefined, (e) => onError(path, e)))
  }
}

export function watchedPaths(): string[] {
  return [...watchers.keys()]
}

export function stopAllWatchers(): void {
  for (const stop of watchers.values()) stop()
  watchers.clear()
}
