import type { Workspace, WorkspaceEntry, Worktree } from '../shared/types'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { git } from './git/exec'
import { listWorktrees } from './git/worktrees'

const MAX_DEPTH = 6
const MAX_REPOS = 200
const CONCURRENCY = 16
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'vendor'])
const WORKTREES_DIR = '.worktrees'

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Main worktree root and dedup key of the repo holding `dir`, or undefined if git cannot tell. */
async function repoIdentity(dir: string): Promise<{ key: string; main: string } | undefined> {
  try {
    const [common, top] = (await git(dir, ['rev-parse', '--git-common-dir', '--show-toplevel'])).split('\n')
    const key = await realpath(resolve(dir, common))
    const main = basename(key) === '.git' ? dirname(key) : await realpath(top)
    return { key, main }
  } catch {
    return undefined
  }
}

export async function findRepos(root: string): Promise<{ repos: string[]; truncated: boolean }> {
  const found = new Map<string, string>()
  let truncated = false
  let level = [root]

  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && !truncated; depth++) {
    const results = await mapLimit(level, CONCURRENCY, async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const children = entries
        .filter((e) => e.isDirectory() && !IGNORED.has(e.name) && (!e.name.startsWith('.') || e.name === WORKTREES_DIR))
        .map((e) => join(dir, e.name))
      const isRepo = entries.some((e) => e.name === '.git')
      const id = isRepo ? await repoIdentity(dir) : undefined
      // A repo is not descended into, except the opened folder itself.
      return { id, children: !isRepo || dir === root ? children : [] }
    })
    const next: string[] = []
    for (const r of results) {
      if (r.id && !found.has(r.id.key)) {
        if (found.size >= MAX_REPOS) { truncated = true; continue }
        found.set(r.id.key, r.id.main)
      }
      next.push(...r.children)
    }
    level = next
  }
  return { repos: [...found.values()].sort(), truncated }
}

/** Where a worktree sits relative to the opened folder: `<root>/.worktrees/<feature>/<repo name>` is a feature. */
export function entryGroup(root: string, w: Worktree, repo: string): Pick<WorkspaceEntry, 'group' | 'feature'> {
  if (w.isMain) return { group: 'main' }
  const parts = relative(root, w.path).split(sep)
  if (parts.length === 3 && parts[0] === WORKTREES_DIR && parts[2] === basename(repo)) {
    return { group: 'feature', feature: parts[1] }
  }
  return { group: 'other' }
}

export async function scanWorkspace(root: string): Promise<Workspace> {
  const real = await realpath(root)
  const { repos, truncated } = await findRepos(real)
  const lists = await mapLimit(repos, CONCURRENCY, (repo) => listWorktrees(repo).catch(() => undefined))
  const entries: WorkspaceEntry[] = []
  repos.forEach((repo, i) => {
    for (const worktree of lists[i] ?? []) {
      const g = entryGroup(real, worktree, repo)
      const space = repo === real && repos.length > 1 && worktree.isMain
      entries.push({ repo, repoName: basename(repo), worktree, ...(space ? { group: 'space' } : g) })
    }
  })
  return { root, entries, truncated }
}
