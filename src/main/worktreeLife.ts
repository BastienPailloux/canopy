import type { OrphanedWorktree } from '../shared/api'
import { isUnder, type Workspace, type Worktree } from '../shared/types'

/** What runs in a worktree, whatever the repo: sessions and terminals only know their folder. */
export interface LiveProcesses {
  sessions: (cwd: string) => number
  terminals: (cwd: string) => number
  stopSessions: (cwd: string) => void
  killTerminals: (cwd: string) => void
}

/** Removes the worktree, then ends what ran there: they would sit in a folder that is gone. If git refuses, nothing stops. */
export async function removeAndStop(
  repo: string, path: string, force: boolean, live: LiveProcesses,
  remove: (repo: string, path: string, force: boolean) => Promise<void>
): Promise<void> {
  await remove(repo, path, force)
  live.stopSessions(path)
  live.killTerminals(path)
}

/**
 * Remembers the worktrees each repo listed. Once one leaves the list, git says nothing more of it, and its
 * processes know only a path: this is what ties them back to the repo, so that they stay reachable.
 */
export class OrphanTracker {
  private readonly known = new Map<string, Map<string, Worktree>>()
  private readonly listed = new Map<string, Set<string>>()
  /** Every repo a scan of the folder found, deleted ones included. */
  private readonly scanned = new Map<string, Set<string>>()

  observe(repo: string, list: Worktree[]): void {
    const seen = this.known.get(repo) ?? new Map<string, Worktree>()
    for (const w of list) seen.set(w.path, w)
    this.known.set(repo, seen)
    this.listed.set(repo, new Set(list.map((w) => w.path)))
  }

  /** Takes the lists of a whole scan. A repo it no longer finds lists nothing, unless the scan cannot tell. */
  observeScan(scan: Workspace): void {
    const lists = new Map<string, Worktree[]>()
    for (const e of scan.entries) lists.set(e.repo, [...(lists.get(e.repo) ?? []), e.worktree])
    for (const [repo, list] of lists) this.observe(repo, list)
    const known = this.repos(scan.root)
    for (const repo of known) {
      if (!lists.has(repo) && !scan.truncated && !isUnder(scan.failed, repo)) this.observe(repo, [])
    }
    this.scanned.set(scan.root, new Set([...known, ...lists.keys()]))
  }

  /** The repos of a folder as scans found them. */
  repos(root: string): string[] {
    return [...(this.scanned.get(root) ?? [])]
  }

  /** The orphans of every repo of a folder. */
  orphansUnder(root: string, live: Pick<LiveProcesses, 'sessions' | 'terminals'>): OrphanedWorktree[] {
    return this.repos(root).flatMap((repo) => this.orphans(repo, live))
  }

  /** Worktrees gone from the list with something still running. One with nothing running is forgotten. */
  orphans(repo: string, live: Pick<LiveProcesses, 'sessions' | 'terminals'>): OrphanedWorktree[] {
    const seen = this.known.get(repo)
    const listed = this.listed.get(repo)
    if (!seen || !listed) return []
    const found: OrphanedWorktree[] = []
    for (const [path, worktree] of seen) {
      if (listed.has(path)) continue
      const sessions = live.sessions(path)
      const terminals = live.terminals(path)
      if (sessions + terminals > 0) found.push({ ...worktree, repo, sessions, terminals })
      else seen.delete(path)
    }
    return found
  }
}
