import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import { changedFiles, readAtBase } from '../git/diff'
import { listBranches, resolveCompareRef } from '../git/refs'
import { listTree, readFileSafe, writeFileSafe } from './files'
import { syncWatchers } from './watchers'

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

/** A path inside the repository, for git. Files on disk get a stricter check in `files.ts`. */
function assertRepoPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || isAbsolute(p) || p.split('/').includes('..')) {
    throw new Error('Chemin invalide')
  }
}

export function registerCodeIpc(broadcast: (event: string, payload?: unknown) => void): void {
  ipcMain.handle('code:listTree', (_e, cwd: unknown) => {
    assertPath(cwd)
    return listTree(cwd)
  })

  ipcMain.handle('code:changes', async (_e, cwd: unknown, base: unknown) => {
    assertPath(cwd)
    const ref = await resolveCompareRef(cwd, base)
    return { base: ref, files: await changedFiles(cwd, ref.ref) }
  })

  ipcMain.handle('code:branches', (_e, cwd: unknown) => {
    assertPath(cwd)
    return listBranches(cwd)
  })

  ipcMain.handle('code:readBase', async (_e, cwd: unknown, base: unknown, path: unknown) => {
    assertPath(cwd)
    assertRepoPath(path)
    return readAtBase(cwd, (await resolveCompareRef(cwd, base)).ref, path)
  })

  ipcMain.handle('code:readFile', (_e, cwd: unknown, path: unknown) => {
    assertPath(cwd)
    return readFileSafe(cwd, path as string)
  })

  ipcMain.handle('code:writeFile', (_e, cwd: unknown, path: unknown, content: unknown, expectedVersion: unknown) => {
    assertPath(cwd)
    if (typeof content !== 'string') throw new Error('Contenu invalide')
    if (expectedVersion !== undefined && typeof expectedVersion !== 'string') throw new Error('Version invalide')
    return writeFileSafe(cwd, path as string, content, expectedVersion === undefined ? {} : { expectedVersion })
  })

  ipcMain.handle('code:watch', async (_e, repo: unknown) => {
    assertPath(repo)
    await syncWatchers(
      repo,
      (cwd) => broadcast('code:changed', { cwd }),
      (cwd, e) => broadcast('code:watchError', { cwd, message: e.message })
    )
  })
}
