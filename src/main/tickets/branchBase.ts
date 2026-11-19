import type { BaseRef } from '../../shared/types'
import type { AppStore } from '../appStore'
import { currentBranch } from '../git/switchBranch'
import { hasRef, mainWorktreeRoot } from '../git/worktrees'

type BaseStore = Pick<AppStore, 'branchBase' | 'setBranchBase'>

/** A base is a local branch, or a remote one as `origin/x`. */
const baseExists = async (root: string, base: string): Promise<boolean> =>
  (await hasRef(root, `refs/heads/${base}`)) || (await hasRef(root, `refs/remotes/${base}`))

/** The base remembered for the branch checked out at `cwd`; forgotten once the base is gone. */
export async function branchBaseAt(store: BaseStore, cwd: string): Promise<{ base: string } | { lost: string } | null> {
  const root = await mainWorktreeRoot(cwd)
  const branch = await currentBranch(cwd)
  if (branch === null) return null
  const base = store.branchBase(root, branch)
  if (base === undefined) return null
  if (await baseExists(root, base)) return { base }
  store.setBranchBase(root, branch, null)
  return { lost: base }
}

/**
 * What the branch at `cwd` is compared to when the user picked nothing: its own base while it exists, else `repoBase`.
 * Leaves a lost base remembered: `branchBaseAt` reports it, then forgets it.
 */
export async function compareBaseAt(store: Pick<AppStore, 'branchBase'>, cwd: string, repoBase: (cwd: string) => Promise<BaseRef>): Promise<BaseRef> {
  const root = await mainWorktreeRoot(cwd)
  const branch = await currentBranch(cwd)
  const base = branch === null ? undefined : store.branchBase(root, branch)
  if (base !== undefined && (await baseExists(root, base))) return { name: base, ref: base }
  return repoBase(cwd)
}
