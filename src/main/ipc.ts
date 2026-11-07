import { BrowserWindow, dialog, ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { AppStore } from './appStore'
import { git } from './git/exec'
import { resolveBaseRef } from './git/refs'
import { worktreeStats } from './git/diff'
import { createWorktree, listWorktrees, removalRisks, removeWorktree } from './git/worktrees'

/** Push an event to every renderer (received through `CanopyApi.on`). */
export function broadcast(event: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('canopy:event', event, payload)
}

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
}

/** Top-level directory of the repo containing `dir`, or null if it is not inside a git work tree. */
async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

export function registerIpc(store: AppStore): void {
  ipcMain.handle('repo:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Ouvrir un dépôt git' }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const root = await repoRoot(res.filePaths[0])
    if (!root) throw new Error(`Ce dossier n'est pas un dépôt git : ${res.filePaths[0]}`)
    store.addRecentRepo(root)
    return root
  })

  ipcMain.handle('repo:select', async (_e, path: unknown) => {
    assertPath(path)
    const root = await repoRoot(path)
    if (!root) return null
    store.addRecentRepo(root)
    return root
  })

  ipcMain.handle('repo:recent', () => store.recentRepos)

  ipcMain.handle('worktree:list', (_e, repo: unknown) => {
    assertPath(repo)
    return listWorktrees(repo)
  })

  ipcMain.handle('worktree:stats', async (_e, cwd: unknown) => {
    assertPath(cwd)
    return worktreeStats(cwd, (await resolveBaseRef(cwd)).ref)
  })

  ipcMain.handle('worktree:create', async (_e, repo: unknown, o: { name: string; branch: string; base?: string }) => {
    assertPath(repo)
    if (typeof o?.name !== 'string' || typeof o.branch !== 'string' || o.name === '' || o.branch === '') {
      throw new Error('Nom ou branche invalide')
    }
    const base = o.base ?? (await resolveBaseRef(repo)).ref
    return createWorktree(repo, { name: o.name, branch: o.branch, base })
  })

  ipcMain.handle('worktree:risks', async (_e, repo: unknown, path: unknown) => {
    assertPath(repo)
    assertPath(path)
    return removalRisks(path, (await resolveBaseRef(repo)).ref)
  })

  ipcMain.handle('worktree:remove', (_e, repo: unknown, path: unknown, force: unknown) => {
    assertPath(repo)
    assertPath(path)
    return removeWorktree(repo, path, force === true)
  })
}
