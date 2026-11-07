import { useApp } from '../store'

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

let opening = 0

/** Scans `folder` and shows it, on its last entry with `restore`. The last folder asked for wins, however long each scan takes. */
async function enter(folder: string, restore = false): Promise<void> {
  const id = ++opening
  const [workspace, last] = await Promise.all([
    window.canopy.scanWorkspace(folder),
    restore ? window.canopy.lastEntry(folder).catch(() => null) : null
  ])
  if (id !== opening) return
  useApp.getState().setOpenError(null)
  useApp.getState().setWorkspace(workspace)
  const entry = workspace.entries.find((e) => e.worktree.path === last)
  if (entry) useApp.getState().selectEntry(entry)
}

/** Native picker, then show the chosen folder. A failure goes to `openError`, in French. */
export async function openRepoFlow(): Promise<void> {
  try {
    const folder = await window.canopy.openRepo()
    if (folder) await enter(folder)
  } catch (e) {
    useApp.getState().setOpenError(errorText(e))
  }
}

/** Re-open a known folder, `restore` for its last entry. False if it is gone; one that holds no repo anymore is reported through `openError`. */
export async function selectRepoFlow(path: string, restore = false): Promise<boolean> {
  try {
    const folder = await window.canopy.selectRepo(path)
    if (!folder) return false
    await enter(folder, restore)
  } catch (e) {
    useApp.getState().setOpenError(`${path} : ${errorText(e)}`)
  }
  return true
}

/** A folder asked for by `canopy .` or `open -a Canopy`: shown on the entry it was left on. */
export const openFromTerminal = (path: string): Promise<boolean> => selectRepoFlow(path, true)

/** Saves each selected entry for the next launch. An orphan is not one: it will not be there. Returns the stop function. */
export function connectLastEntry(): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.worktree === prev.worktree || !s.worktree || !s.workspace) return
    if (s.workspace.entries.some((e) => e.worktree.path === s.worktree)) void window.canopy.setLastEntry(s.workspace.root, s.worktree).catch(() => undefined)
  })
}
