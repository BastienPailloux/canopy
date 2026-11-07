import { useApp } from '../store'

/** Native picker, then make the chosen repo current. Errors are returned as a French message. */
export async function openRepoFlow(): Promise<string | null> {
  try {
    const repo = await window.canopy.openRepo()
    if (repo) useApp.getState().setRepo(repo)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Re-open a known repo. False if it is gone. */
export async function selectRepoFlow(path: string): Promise<boolean> {
  try {
    const repo = await window.canopy.selectRepo(path)
    if (repo) useApp.getState().setRepo(repo)
    return repo !== null
  } catch {
    return false
  }
}
