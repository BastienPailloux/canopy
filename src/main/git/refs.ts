import type { BaseRef } from '../../shared/types'
import { git, GitError } from './exec'

async function exists(repo: string, ref: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

const BASE_NAMES = ['main', 'master', 'develop']

/**
 * origin/HEAD, then the usual names on origin, then locally, then origin's only branch.
 * A remote branch goes first: a clone's local main is often stale, and would show others' commits as this branch's.
 */
export async function resolveBaseRef(repo: string): Promise<BaseRef> {
  try {
    const out = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (out.startsWith('origin/') && (await exists(repo, `refs/remotes/${out}`))) {
      return { name: out.slice('origin/'.length), ref: out }
    }
  } catch {
    // no origin/HEAD
  }
  for (const name of BASE_NAMES) {
    if (await exists(repo, `refs/remotes/origin/${name}`)) return { name, ref: `origin/${name}` }
  }
  for (const name of BASE_NAMES) {
    if (await exists(repo, `refs/heads/${name}`)) return { name, ref: name }
  }
  const remote = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']))
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
