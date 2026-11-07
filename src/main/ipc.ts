import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { isAbsolute } from 'node:path'
import type { NewWorktree } from '../shared/api'
import type { WorktreeStats } from '../shared/types'
import type { AppStore } from './appStore'
import { registerCodeIpc } from './code/codeIpc'
import type { LspPool } from './code/lsp'
import { openExternalUrl } from './externalLinks'
import { git } from './git/exec'
import { cachedBaseRef, cachedWorktrees, clearSharedReads, Coalescer } from './git/sharedReads'
import { worktreeStats } from './git/diff'
import { createWorktree, removalRisks, removeWorktree } from './git/worktrees'
import { PrCache, repoNeedsAttention, worktreeStatus } from './status'
import { approveConfig, repoTrust, requireTrustedRoot } from './repoTrust'
import type { SessionManager } from './sessions/SessionManager'
import { registerTerminalIpc } from './terminal/terminalIpc'
import type { TerminalManager } from './terminal/TerminalManager'
import { assertContent, assertId, assertMode, parseDecision, parseStartOptions } from './sessions/validate'

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

function parseNewWorktree(raw: unknown): NewWorktree {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const { name, branch, base, parentDir, existing } = o
  if (typeof name !== 'string' || typeof branch !== 'string' || name === '' || branch === '') throw new Error('Nom ou branche invalide')
  if (base !== undefined && (typeof base !== 'string' || base === '' || base.startsWith('-'))) throw new Error('Base invalide')
  if (parentDir !== undefined) assertPath(parentDir)
  return { name, branch, ...(base !== undefined ? { base } : {}), ...(parentDir !== undefined ? { parentDir } : {}), existing: existing === true }
}

function registerSessionIpc(store: AppStore, sessions: SessionManager): void {
  sessions.on('message', (e) => broadcast('session:message', e))
  sessions.on('permission', (e) => broadcast('session:permission', e))
  sessions.on('permissionCancelled', (e) => broadcast('session:permissionCancelled', e))
  sessions.on('commandsChanged', (e) => broadcast('session:commandsChanged', e))
  sessions.on('state', (e) => broadcast('session:state', e))

  ipcMain.handle('session:start', async (_e, cwd: unknown, o: unknown) => {
    assertPath(cwd)
    const options = parseStartOptions(o)
    return sessions.start(cwd, { ...options, repoRoot: await requireTrustedRoot(store, cwd) })
  })

  ipcMain.handle('session:send', (_e, localId: unknown, content: unknown) => {
    assertId(localId)
    assertContent(content)
    sessions.send(localId, content)
  })

  ipcMain.handle('session:interrupt', (_e, localId: unknown) => {
    assertId(localId)
    return sessions.interrupt(localId)
  })

  ipcMain.handle('session:setMode', (_e, localId: unknown, mode: unknown) => {
    assertId(localId)
    assertMode(mode)
    return sessions.setMode(localId, mode)
  })

  ipcMain.handle('session:setModel', (_e, localId: unknown, model: unknown) => {
    assertId(localId)
    assertId(model)
    return sessions.setModel(localId, model)
  })

  ipcMain.handle('session:stop', (_e, localId: unknown) => {
    assertId(localId)
    sessions.stop(localId)
  })

  ipcMain.handle('session:resolvePermission', (_e, requestId: unknown, decision: unknown) => {
    assertId(requestId)
    sessions.resolvePermission(requestId, parseDecision(decision))
  })

  ipcMain.handle('session:pendingPermissions', () => sessions.pendingPermissions())

  ipcMain.handle('session:list', (_e, cwd: unknown) => {
    assertPath(cwd)
    return sessions.list(cwd)
  })

  ipcMain.handle('session:history', (_e, cwd: unknown, sessionId: unknown) => {
    assertPath(cwd)
    assertId(sessionId)
    return sessions.history(cwd, sessionId)
  })

  ipcMain.handle('session:activity', (_e, cwd: unknown) => {
    assertPath(cwd)
    return sessions.activity(cwd)
  })

  ipcMain.handle('session:commands', (_e, localId: unknown) => {
    assertId(localId)
    return sessions.commands(localId)
  })

  ipcMain.handle('session:models', (_e, localId: unknown) => {
    assertId(localId)
    return sessions.models(localId)
  })
}

export function registerIpc(store: AppStore, sessions: SessionManager, lsp: LspPool, terminals: TerminalManager): void {
  registerSessionIpc(store, sessions)
  registerTerminalIpc(store, terminals, broadcast)
  const prs = new PrCache()

  ipcMain.handle('worktree:status', async (_e, cwd: unknown, onFocus: unknown) => {
    assertPath(cwd)
    return worktreeStatus(sessions.activity(cwd), await prs.get(cwd, onFocus === true))
  })

  ipcMain.handle('repo:needsAttention', (_e, path: unknown) => {
    assertPath(path)
    return repoNeedsAttention(path, {
      worktrees: async (repo) => (await cachedWorktrees(repo)).map((w) => w.path),
      activity: (cwd) => sessions.activity(cwd)
    })
  })

  // The key goes in, never out: the renderer only learns whether one is set.
  ipcMain.handle('settings:apiKeyStatus', () => ({ set: store.hasApiKey(), encryptionAvailable: store.encryptionAvailable }))

  ipcMain.handle('settings:saveApiKey', (_e, key: unknown) => {
    if (key !== null && (typeof key !== 'string' || key.length > 512 || /\s/.test(key))) throw new Error('Clé API invalide')
    store.saveApiKey(key)
  })

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

  ipcMain.handle('repo:trust', (_e, cwd: unknown) => {
    assertPath(cwd)
    return repoTrust(store, cwd)
  })

  ipcMain.handle('repo:trustRepo', (_e, cwd: unknown, configHash: unknown) => {
    assertPath(cwd)
    assertId(configHash)
    return approveConfig(store, cwd, configHash)
  })

  ipcMain.handle('shell:openExternal', (_e, url: unknown) => openExternalUrl(url, (u) => shell.openExternal(u)))

  registerCodeIpc(broadcast, lsp)

  ipcMain.handle('worktree:list', (_e, repo: unknown) => {
    assertPath(repo)
    return cachedWorktrees(repo)
  })

  const stats = new Coalescer<WorktreeStats>()
  ipcMain.handle('worktree:stats', (_e, cwd: unknown) => {
    assertPath(cwd)
    return stats.run(cwd, async () => worktreeStats(cwd, (await cachedBaseRef(cwd)).ref))
  })

  ipcMain.handle('worktree:defaultBase', (_e, cwd: unknown) => {
    assertPath(cwd)
    return cachedBaseRef(cwd).catch(() => null)
  })

  ipcMain.handle('worktree:create', async (_e, repo: unknown, raw: unknown) => {
    assertPath(repo)
    const o = parseNewWorktree(raw)
    const base = o.existing ? undefined : o.base ?? (await cachedBaseRef(repo)).ref
    const created = await createWorktree(repo, { ...o, base })
    clearSharedReads()
    return created
  })

  ipcMain.handle('worktree:risks', async (_e, repo: unknown, path: unknown) => {
    assertPath(repo)
    assertPath(path)
    return removalRisks(path, (await cachedBaseRef(repo)).ref)
  })

  ipcMain.handle('worktree:remove', (_e, repo: unknown, path: unknown, force: unknown) => {
    assertPath(repo)
    assertPath(path)
    return removeWorktree(repo, path, force === true).then(() => {
      clearSharedReads()
      // Their shells would sit in a folder that is gone: they end, and the exit is reported.
      for (const t of terminals.list(path)) terminals.kill(t.id)
    })
  })
}
