import type { Activity } from '../shared/types'
import { openPrBranches } from './git/pr'

export type { Activity }

export interface AttentionDeps {
  /** Paths of every worktree of the repo, wherever they live. */
  worktrees: (repoPath: string) => Promise<string[]>
  activity: (cwd: string) => Activity
}

/** Whether a session in any worktree of the repo waits for an answer, displayed or not. */
export async function repoNeedsAttention(repoPath: string, deps: AttentionDeps): Promise<boolean> {
  try {
    return (await deps.worktrees(repoPath)).some((path) => deps.activity(path) === 'waiting')
  } catch {
    return false
  }
}

/** The same for a folder: any repo found under it but `except`. Without one, `folder` is taken as a repo. One at a time: this polls. */
export async function folderNeedsAttention(folder: string, repos: (folder: string) => Promise<string[]>, deps: AttentionDeps, except?: string): Promise<boolean> {
  const found = await repos(folder).catch((): string[] => [])
  for (const repo of found.length > 0 ? found : [folder]) {
    if (repo !== except && await repoNeedsAttention(repo, deps)) return true
  }
  return false
}

const PR_TTL_MS = 60_000
/** Asking sooner still does not hammer gh when the window is toggled quickly. */
const PR_SOON_MIN_MS = 5_000

type OpenPrs = string[] | null

interface PrEntry { branches: OpenPrs; at: number }

/** Open PR branches per repo, null if gh cannot tell: read at most every 60 s, earlier only when asked. Concurrent reads share one gh call. */
export class PrCache {
  private readonly entries = new Map<string, PrEntry>()
  private readonly inFlight = new Map<string, Promise<OpenPrs>>()

  constructor(private readonly read: (repo: string) => Promise<OpenPrs> = openPrBranches, private readonly now: () => number = Date.now) {}

  async get(repo: string, soon = false): Promise<OpenPrs> {
    const entry = this.entries.get(repo)
    const age = entry ? this.now() - entry.at : Infinity
    if (entry && age < (soon ? PR_SOON_MIN_MS : PR_TTL_MS)) return entry.branches
    const running = this.inFlight.get(repo)
    if (running) return running
    const p = this.read(repo).catch((): OpenPrs => null).then((branches) => {
      this.entries.set(repo, { branches, at: this.now() })
      return branches
    }).finally(() => { this.inFlight.delete(repo) })
    this.inFlight.set(repo, p)
    return p
  }
}
