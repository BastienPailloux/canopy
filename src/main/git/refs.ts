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

/** origin/HEAD, then main, then master. */
export async function resolveBaseRef(repo: string): Promise<BaseRef> {
  try {
    const out = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (out.startsWith('origin/') && (await exists(repo, `refs/remotes/${out}`))) {
      return { name: out.slice('origin/'.length), ref: out }
    }
  } catch {
    // no origin/HEAD
  }
  for (const name of ['main', 'master']) {
    if (await exists(repo, `refs/heads/${name}`)) return { name, ref: name }
  }
  throw new GitError('No base branch found (origin/HEAD, main, master)', '')
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
