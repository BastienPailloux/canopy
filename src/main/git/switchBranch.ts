import { git } from './exec'
import { hasRef, listWorktrees } from './worktrees'

/** Marks a stash as Canopy's, for that branch: the stash list is shared by all the worktrees of a repo. */
const TAG = 'canopy:'
/** `git stash push -m x` names it `On <branch>: x`. A ref cannot hold `:`. */
const TAGGED = /^On [^:]+: canopy:(.+)$/

export const currentBranch = async (cwd: string): Promise<string | null> =>
  (await git(cwd, ['symbolic-ref', '--short', '--quiet', 'HEAD'], { okCodes: [1] })).trim() || null

/** Position in the stash list of the latest changes set aside for `branch`. Not `%gd`: `log.date` changes what it prints. */
async function setAsideIndex(cwd: string, branch: string): Promise<number> {
  const subjects = (await git(cwd, ['stash', 'list', '--format=%gs'])).split('\n')
  return subjects.findIndex((s) => TAGGED.exec(s)?.[1] === branch)
}

/** Takes back what was set aside for `branch`. On failure the stash stays, and git leaves the conflict in the files. */
async function restore(cwd: string, branch: string, trusted: boolean): Promise<{ conflict: boolean }> {
  const index = await setAsideIndex(cwd, branch)
  if (index < 0) return { conflict: false }
  return git(cwd, ['stash', 'pop', `stash@{${index}}`], { trusted }).then(() => ({ conflict: false }), () => ({ conflict: true }))
}

/** Files a switch would set aside. */
export const dirtyCount = async (cwd: string): Promise<number> =>
  (await git(cwd, ['status', '--porcelain', '-z'])).split('\0').filter((e) => e !== '').length

/** Whether Canopy set changes aside for `branch`, wherever its worktree is now: the stash list is the repo's. */
export const hasSetAsideFor = async (cwd: string, branch: string): Promise<boolean> => (await setAsideIndex(cwd, branch)) >= 0

/** Whether the branch checked out in `cwd` has changes set aside, which a checkout from outside Canopy did not take back. */
export async function hasSetAsideChanges(cwd: string): Promise<boolean> {
  const branch = await currentBranch(cwd)
  return branch !== null && (await setAsideIndex(cwd, branch)) >= 0
}

/** Branches `cwd` can go to: git refuses one open in a worktree, and a remote one is left out when a local one stands for it. */
export async function switchableBranches(cwd: string): Promise<string[]> {
  const held = new Set((await listWorktrees(cwd)).map((w) => w.branch))
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).split('\n')
  const locals = new Set(refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)))
  const remotes = refs
    .filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD'))
    .map((r) => r.slice('refs/remotes/'.length))
    .filter((r) => !locals.has(r.slice(r.indexOf('/') + 1)) && !held.has(r.slice(r.indexOf('/') + 1)))
  return [...[...locals].filter((b) => !held.has(b)), ...remotes].sort()
}

/** `git switch` arguments for a local branch, or a remote one as `origin/x`, and the branch it ends on. */
async function switchArgs(cwd: string, target: string): Promise<{ args: string[]; branch: string }> {
  if (await hasRef(cwd, `refs/heads/${target}`)) return { args: [target], branch: target }
  if (!(await hasRef(cwd, `refs/remotes/${target}`))) throw new Error(`Branche "${target}" introuvable`)
  const local = target.slice(target.indexOf('/') + 1)
  return (await hasRef(cwd, `refs/heads/${local}`))
    ? { args: [local], branch: local }
    : { args: ['--track', '-c', local, target], branch: local }
}

/**
 * Moves `cwd` to `target`. Its changes are set aside for the branch it leaves, and those of `target` come back.
 * `conflict`: the branch changed, but what was set aside for it could not be applied.
 * The repo's filters and hooks run only if `trusted`: its config was approved.
 */
export async function switchBranch(cwd: string, target: string, { trusted = false }: { trusted?: boolean } = {}): Promise<{ conflict: boolean }> {
  const { args, branch } = await switchArgs(cwd, target)
  const source = await currentBranch(cwd)
  const dirty = (await dirtyCount(cwd)) > 0
  if (dirty && source === null) throw new Error('HEAD détaché : validez ou annulez les modifications avant de changer de branche')
  if (dirty) await git(cwd, ['stash', 'push', '--include-untracked', '-m', `${TAG}${source}`], { trusted })
  try {
    await git(cwd, ['switch', ...args], { trusted })
  } catch (e) {
    if (dirty && source !== null && (await restore(cwd, source, trusted)).conflict) {
      throw new Error(`${e instanceof Error ? e.message : String(e)} — vos modifications sont restées dans le stash ${TAG}${source}`)
    }
    throw e
  }
  return restore(cwd, branch, trusted)
}

/**
 * Starts `branch` from `base` (local, or remote as `origin/x`) in `cwd`. Its changes are set aside for the branch it leaves.
 * Fails if `branch` exists. A new branch has nothing set aside to take back.
 * The repo's filters and hooks run only if `trusted`: its config was approved.
 */
export async function startBranchIn(cwd: string, branch: string, base: string, { trusted = false }: { trusted?: boolean } = {}): Promise<void> {
  if (branch === '' || branch.startsWith('-')) throw new Error(`Nom de branche invalide : "${branch}"`)
  if (base === '' || base.startsWith('-')) throw new Error(`Branche de départ invalide : "${base}"`)
  if (await hasRef(cwd, `refs/heads/${branch}`)) throw new Error(`La branche "${branch}" existe déjà`)
  await git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).catch(() => { throw new Error(`Branche de départ "${base}" introuvable`) })
  const source = await currentBranch(cwd)
  const dirty = (await dirtyCount(cwd)) > 0
  if (dirty && source === null) throw new Error('HEAD détaché : validez ou annulez les modifications avant de changer de branche')
  if (dirty) await git(cwd, ['stash', 'push', '--include-untracked', '-m', `${TAG}${source}`], { trusted })
  try {
    await git(cwd, ['switch', '--no-track', '-c', branch, base, '--'], { trusted })
  } catch (e) {
    if (dirty && source !== null && (await restore(cwd, source, trusted)).conflict) {
      throw new Error(`${e instanceof Error ? e.message : String(e)} — vos modifications sont restées dans le stash ${TAG}${source}`)
    }
    throw e
  }
}
