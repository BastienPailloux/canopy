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
