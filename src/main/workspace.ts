import type { Workspace, WorkspaceEntry, Worktree } from '../shared/types'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { git } from './git/exec'
import { listWorktrees, mainWorktreeRoot } from './git/worktrees'

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
      // Past the cap nothing more is kept: do not spawn git for the rest of a wide level.
      const id = isRepo && !truncated ? await repoIdentity(dir) : undefined
      if (id && !found.has(id.key)) {
        if (found.size >= MAX_REPOS) truncated = true
        else found.set(id.key, id.main)
      }
      // A repo is not descended into, except the opened folder itself.
      return !isRepo || dir === root ? children : []
    })
    level = results.flat()
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
  return { root: real, entries, truncated }
}

/** A base to remember: a name, or null to forget it. Nothing else, or a missing value would remember the default branch. */
export function parseRepoBase(branch: unknown): string | null {
  if (branch !== null && typeof branch !== 'string') throw new Error('Branche invalide')
  return branch
}

/**
 * The folder to open: itself when it holds repos other than its own (a parent folder, or a repo with nested ones),
 * else the root of the repo containing it. Rejects when there is no repo at all.
 */
export async function resolveOpenedFolder(path: string): Promise<string> {
  const real = await realpath(path)
  const { repos } = await findRepos(real)
  const top = await git(real, ['rev-parse', '--show-toplevel']).then((t) => realpath(t.trim()), () => undefined)
  const own = new Set<string>()
  if (top) {
    own.add(top)
    own.add(await mainWorktreeRoot(top).catch(() => top))
  }
  if (repos.some((r) => !own.has(r))) return real
  if (top) return top
  throw new Error('Aucun repo git dans ce dossier')
}
