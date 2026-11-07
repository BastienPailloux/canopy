import type { Workspace } from '../../shared/types'
import { openFromTerminal } from '../shell/repoActions'
import { useApp } from '../store'

/** Whether `cwd` is a worktree the open folder lists. */
export const inWorkspace = (workspace: Workspace | null, cwd: string): boolean =>
  workspace?.entries.some((e) => e.worktree.path === cwd) ?? false

/** Shows a restored file. Its worktree may belong to another folder than the open one: that folder is opened first. */
export async function openRestored(cwd: string, path: string): Promise<void> {
  if (!inWorkspace(useApp.getState().workspace, cwd)) await openFromTerminal(cwd)
  const entry = useApp.getState().workspace?.entries.find((e) => e.worktree.path === cwd)
  if (entry) useApp.getState().selectEntry(entry)
  useApp.getState().openInCode(cwd, path, 'code')
}
