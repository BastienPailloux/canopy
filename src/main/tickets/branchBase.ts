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
