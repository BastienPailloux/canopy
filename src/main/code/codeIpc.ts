import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import { changedFiles, readAtBase } from '../git/diff'
import { listBranches, resolveCompareRef } from '../git/refs'
import { listTree, readFileSafe, writeFileSafe } from './files'
import { searchText } from './search'
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

/** The search running for each window: a newer one cancels it. */
const running = new Map<number, AbortController>()

export function registerCodeIpc(broadcast: (event: string, payload?: unknown) => void): void {
  ipcMain.handle('code:listTree', (_e, cwd: unknown) => {
    assertPath(cwd)
    return listTree(cwd)
  })

  ipcMain.handle('code:search', async (e, cwd: unknown, q: unknown, o: unknown) => {
    assertPath(cwd)
    if (typeof q !== 'string' || q.length > 1000) throw new Error('Recherche invalide')
    const opts = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>
    const limit = opts.limit
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10_000)) throw new Error('Limite invalide')

    const id = e.sender.id
    running.get(id)?.abort()
    const ctl = new AbortController()
    running.set(id, ctl)
    try {
      return await searchText(cwd, q, {
        regex: opts.regex === true,
        caseSensitive: opts.caseSensitive === true,
        limit: limit as number | undefined,
        signal: ctl.signal
      })
    } catch (err) {
      // Replaced by a newer search: null tells the caller there is nothing to show for this one.
      if (err instanceof Error && err.name === 'AbortError') return null
      throw err
    } finally {
      if (running.get(id) === ctl) running.delete(id)
    }
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
