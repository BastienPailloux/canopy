import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { BaseRef, ChangedFile } from '../../shared/types'
import { changedFiles, readAtBase } from '../git/diff'
import { listBranches, resolveCompareRef } from '../git/refs'
import { cachedBaseRef, clearSharedReads, Coalescer } from '../git/sharedReads'
import { listTree, readFileSafe, writeFileSafe } from './files'
import type { LspPool } from './lsp'
import { searchText } from './search'
import { SearchSlots } from './searchSlots'
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

/** A 1-based line or column. */
function assertPosition(n: unknown): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error('Position invalide')
}

/** One search per window and caller: the panel and the bar do not cancel each other. */
const searches = new SearchSlots()
/** File events come in bursts: each worktree and base computes its changes once at a time. */
const changes = new Coalescer<{ base: BaseRef; files: ChangedFile[] }>()

export function registerCodeIpc(broadcast: (event: string, payload?: unknown) => void, lsp: LspPool): void {
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

    const channel = opts.channel
    if (channel !== 'panel' && channel !== 'bar') throw new Error('Appelant invalide')
    // null: replaced by a newer search of the same caller.
    return searches.run(`${e.sender.id}:${channel}`, (signal) => searchText(cwd, q, {
      regex: opts.regex === true,
      caseSensitive: opts.caseSensitive === true,
      limit: limit as number | undefined,
      signal
    }))
  })

  const navigation = (find: 'definition' | 'references') => (_e: unknown, cwd: unknown, path: unknown, line: unknown, col: unknown) => {
    assertPath(cwd)
    assertRepoPath(path)
    assertPosition(line)
    assertPosition(col)
    return lsp[find](cwd, path, line, col)
  }
  ipcMain.handle('code:definition', navigation('definition'))
  ipcMain.handle('code:references', navigation('references'))

  ipcMain.handle('code:symbols', (e, cwd: unknown, q: unknown) => {
    assertPath(cwd)
    if (typeof q !== 'string' || q.length > 1000) throw new Error('Recherche invalide')
    // null: replaced by a newer search of the same window.
    return searches.run(`${e.sender.id}:symbols`, (signal) => lsp.symbols(cwd, q, signal))
  })

  ipcMain.handle('code:changes', async (_e, cwd: unknown, base: unknown) => {
    assertPath(cwd)
    return changes.run(`${cwd}\0${String(base)}`, async () => {
      const ref = base === undefined ? await cachedBaseRef(cwd) : await resolveCompareRef(cwd, base)
      return { base: ref, files: await changedFiles(cwd, ref.ref) }
    })
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
      (cwd) => {
        clearSharedReads()
        broadcast('code:changed', { cwd })
      },
      (cwd, e) => broadcast('code:watchError', { cwd, message: e.message }),
      (cwd) => lsp.release(cwd)
    )
  })
}
