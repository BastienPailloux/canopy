import type { AutoMergeEntry, CleanupRequest } from '../../shared/pr'
import type { AppStore } from '../appStore'
import type { PrGateway } from './gateway'

const POLL_MS = 60_000

export interface AutoMergeWatchDeps {
  store: AppStore
  gateway: PrGateway
  broadcast: (event: string, payload: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
}

export interface AutoMergeWatch {
  /** Polls every 60 s from now on. */
  start(): void
  /** Watches the auto-merge enabled in `cwd`, or stops watching it with null. */
  watch(cwd: string, entry: AutoMergeEntry | null): void
  /** One look at every watched PR. */
  poll(): Promise<void>
}

/**
 * Follows the auto-merges enabled from the tab, across restarts (`AppStore.autoMerges`): once GitHub merges one, the
 * renderer gets `pr:autoMerged` with the box state (`cleanup`) and runs what follows a merge. A closed one is just forgotten.
 */
export function createAutoMergeWatch(d: AutoMergeWatchDeps): AutoMergeWatch {
  let running: Promise<void> | null = null

  const check = async (cwd: string, entry: AutoMergeEntry): Promise<void> => {
    // offline, gh logged out: asked again next time
    const pr = await d.gateway.find(cwd, entry.branch).catch(() => null)
    if (pr === null || pr.number !== entry.number) return
    if (pr.state !== 'merged' && pr.state !== 'closed') return
    let req: CleanupRequest | null = null
    if (pr.state === 'merged') {
      // The head GitHub merged: commits may have been pushed since the auto-merge was enabled. Unread: asked again next time.
      const detail = await d.gateway.view(cwd, entry.number).catch(() => null)
      if (detail === null || detail.state !== 'merged') return
      req = { number: entry.number, branch: entry.branch, headOid: detail.headOid }
    }
    // Re-read: the entry may have been replaced or dropped while gh answered.
    const now = d.store.autoMerges[cwd]
    if (now === undefined || now.number !== entry.number || now.branch !== entry.branch) return
    d.store.setAutoMerge(cwd, null)
    // Unchecked box too: the renderer still moves the ticket to Done, and only cleans up when `cleanup`.
    if (req) d.broadcast('pr:autoMerged', { cwd, req, cleanup: entry.cleanup })
  }

  const poll = (): Promise<void> => {
    // one poll at a time: two would both see the merge and broadcast twice
    running ??= Promise.all(Object.entries(d.store.autoMerges).map(([cwd, e]) => check(cwd, e)))
      .then(() => undefined)
      .finally(() => { running = null })
    return running
  }

  return {
    start() {
      d.setInterval(() => { void poll() }, POLL_MS)
    },
    watch(cwd, entry) {
      d.store.setAutoMerge(cwd, entry)
    },
    poll,
  }
}
