import type { BaseRef } from '../../shared/types'
import { git, GitError } from './exec'
import { listWorktrees } from './worktrees'

async function exists(repo: string, ref: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env })
    return true
  } catch {
    return false
  }
}

const BASE_NAMES = ['main', 'master', 'develop']

/**
 * origin/HEAD, then the usual names on origin, then locally, then origin's only branch.
 * A remote branch goes first: a clone's local main is often stale, and would show others' commits as this branch's.
 * `env` reaches every git call (e.g. to forbid a lazy fetch while checking a commit exists).
 */
export async function resolveBaseRef(repo: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<BaseRef> {
  const { env } = opts
  try {
    const out = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { env })).trim()
    if (out.startsWith('origin/') && (await exists(repo, `refs/remotes/${out}`, env))) {
      return { name: out.slice('origin/'.length), ref: out }
    }
  } catch {
    // no origin/HEAD
  }
  for (const name of BASE_NAMES) {
    if (await exists(repo, `refs/remotes/origin/${name}`, env)) return { name, ref: `origin/${name}` }
  }
  for (const name of BASE_NAMES) {
    if (await exists(repo, `refs/heads/${name}`, env)) return { name, ref: name }
  }
  const remote = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], { env }))
    .split('\n')
    .filter((b) => b.startsWith('origin/') && b !== 'origin/HEAD')
  if (remote.length === 1) return { name: remote[0].slice('origin/'.length), ref: remote[0] }
  throw new GitError('No base branch found (origin/HEAD, main, master, develop)', '')
}

export async function mergeBase(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['merge-base', 'HEAD', ref])).trim()
}

/** Number of commits on HEAD not in ref. */
export async function aheadCount(cwd: string, ref: string): Promise<number> {
  return parseInt((await git(cwd, ['rev-list', '--count', `${ref}..HEAD`])).trim(), 10)
}

/** The ref the user picked to compare against, or the default base when none. Rejects an unknown ref. */
export async function resolveCompareRef(repo: string, picked?: unknown): Promise<BaseRef> {
  if (picked === undefined) return resolveBaseRef(repo)
  if (typeof picked !== 'string' || picked === '' || picked.startsWith('-') || !(await exists(repo, picked))) {
    throw new Error('Branche de comparaison inconnue')
  }
  return { name: picked, ref: picked }
}

/** Local and remote branches to compare against, without the `origin/HEAD` alias. */
export async function listBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  const names = out.split('\n').flatMap((r) => {
    if (r.startsWith('refs/heads/')) return [r.slice('refs/heads/'.length)]
    if (r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')) return [r.slice('refs/remotes/'.length)]
    return []
  })
  return [...new Set(names)].sort()
}

/**
 * Among the branches open in the repo's other worktrees, the one with most commits not in `defaultRef`.
 * A tie goes to the latest commit. Null when none is ahead.
 */
export async function mostAdvancedBranch(repo: string, defaultRef: string): Promise<{ branch: string; ahead: number } | null> {
  let best: { branch: string; ahead: number; time: number } | null = null
  for (const w of await listWorktrees(repo)) {
    if (w.isMain || w.branch === null) continue
    const ahead = await aheadCount(w.path, defaultRef)
    if (ahead <= 0) continue
    const time = parseInt((await git(w.path, ['log', '-1', '--format=%ct', 'HEAD'])).trim(), 10)
    if (best === null || ahead > best.ahead || (ahead === best.ahead && time > best.time)) best = { branch: w.branch, ahead, time }
  }
  return best && { branch: best.branch, ahead: best.ahead }
}
