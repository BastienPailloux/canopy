import { useApp } from '../store'

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

let opening = 0

/** Scans `folder` and shows it. The last folder asked for wins, however long each scan takes. */
async function enter(folder: string): Promise<void> {
  const id = ++opening
  const workspace = await window.canopy.scanWorkspace(folder)
  if (id === opening) useApp.getState().setWorkspace(workspace)
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

/** Re-open a known folder. False if it is gone; one that holds no repo anymore is reported through `openError`. */
export async function selectRepoFlow(path: string): Promise<boolean> {
  try {
    const folder = await window.canopy.selectRepo(path)
    if (!folder) return false
    await enter(folder)
  } catch (e) {
    useApp.getState().setOpenError(`${path} : ${errorText(e)}`)
  }
  return true
}
