import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { NewWorktree } from '../shared/api'
import type { Worktree, WorktreeStats } from '../shared/types'
import type { AppStore } from './appStore'
import { registerCodeIpc } from './code/codeIpc'
import type { LspPool } from './code/lsp'
import { openExternalUrl } from './externalLinks'
import { resolveCompareRef } from './git/refs'
import { cachedBaseRef, cachedWorktrees, clearSharedReads, Coalescer, setBaseOverride, TtlCache } from './git/sharedReads'
import { worktreeStats } from './git/diff'
import { OrphanTracker, removeAndStop, type LiveProcesses } from './worktreeLife'
import { createWorktree, mainWorktreeRoot, removalRisks, removeWorktree } from './git/worktrees'
import { parseUnsaved, type UnsavedCounts } from './quit'
import { folderNeedsAttention, PrCache, type AttentionDeps } from './status'
import { approveConfig, repoTrust, requireTrustedRoot } from './repoTrust'
import { findRepos, parseRepoBase, resolveOpenedFolder, scanWorkspace } from './workspace'
import type { SessionManager } from './sessions/SessionManager'
import { registerTerminalIpc } from './terminal/terminalIpc'
import type { TerminalManager } from './terminal/TerminalManager'
import { assertContent, assertId, assertMode, parseDecision, parseStartOptions } from './sessions/validate'

/** The repo picker asks about each recent folder on every session change: a walk of the disk cannot follow that pace. */
const FOLDER_REPOS_TTL_MS = 5 * 60_000

/** Push an event to every renderer (received through `CanopyApi.on`). */
export function broadcast(event: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('canopy:event', event, payload)
}

function assertPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Error('Chemin invalide')
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

export function registerIpc(
  store: AppStore, sessions: SessionManager, lsp: LspPool, terminals: TerminalManager, onUnsaved: (counts: UnsavedCounts) => void
): void {
  registerSessionIpc(store, sessions)
  registerTerminalIpc(store, terminals, broadcast)
  ipcMain.handle('app:unsaved', (_e, counts: unknown) => { onUnsaved(parseUnsaved(counts)) })

  const prs = new PrCache()
  const orphans = new OrphanTracker()
  const live: LiveProcesses = {
    sessions: (cwd) => sessions.liveCount(cwd),
    terminals: (cwd) => terminals.runningIn(cwd),
    stopSessions: (cwd) => sessions.stopIn(cwd),
    killTerminals: (cwd) => terminals.killIn(cwd)
  }

  ipcMain.handle('repo:openPrs', (_e, repo: unknown, soon: unknown) => {
    assertPath(repo)
    return prs.get(repo, soon === true)
  })

  const attention: AttentionDeps = {
    // Orphans too: a session left in a folder that is gone can still ask a question.
    worktrees: async (repo) => [
      ...(await cachedWorktrees(repo).catch((): Worktree[] => [])),
      ...orphans.orphans(repo, live)
    ].map((w) => w.path),
    activity: (cwd) => sessions.activity(cwd)
  }
  const folderRepos = new TtlCache<string[]>(FOLDER_REPOS_TTL_MS)
  /** What a walk finds, and what scans knew there: a deleted repo can still hold a session. */
  const reposUnder = async (folder: string): Promise<string[]> => [
    ...new Set([...await folderRepos.get(folder, async () => (await findRepos(folder)).repos), ...orphans.repos(folder)])
  ]

  ipcMain.handle('repo:needsAttention', (_e, path: unknown, except: unknown) => {
    assertPath(path)
    if (except !== undefined) assertPath(except)
    return folderNeedsAttention(path, reposUnder, attention, except)
  })

  ipcMain.handle('settings:trustedRepos', () => store.trustedRepos)

  ipcMain.handle('settings:revokeRepo', (_e, root: unknown) => {
    assertPath(root)
    store.revokeRepo(root)
  })

  // The key goes in, never out: the renderer only learns whether one is set.
  ipcMain.handle('settings:apiKeyStatus', () => ({ set: store.hasApiKey(), encryptionAvailable: store.encryptionAvailable }))

  ipcMain.handle('settings:saveApiKey', (_e, key: unknown) => {
    if (key !== null && (typeof key !== 'string' || key.length > 512 || /\s/.test(key))) throw new Error('Clé API invalide')
    store.saveApiKey(key)
  })

  setBaseOverride(async (cwd) => store.repoBases[await mainWorktreeRoot(cwd)])

  ipcMain.handle('repo:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Ouvrir un dépôt git ou un dossier de dépôts' }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const folder = await resolveOpenedFolder(res.filePaths[0])
    store.addRecentRepo(folder)
    return folder
  })

  ipcMain.handle('repo:select', async (_e, path: unknown) => {
    assertPath(path)
    let folder: string
    try {
      folder = await resolveOpenedFolder(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    store.addRecentRepo(folder)
    return folder
  })

  ipcMain.handle('workspace:scan', async (_e, root: unknown) => {
    assertPath(root)
    const scan = await scanWorkspace(root)
    orphans.observeScan(scan)
    return scan
  })

  ipcMain.handle('repo:setBase', async (_e, repo: unknown, branch: unknown) => {
    assertPath(repo)
    const picked = parseRepoBase(branch)
    const base = picked === null ? null : (await resolveCompareRef(repo, picked)).name
    store.setRepoBase(await mainWorktreeRoot(repo), base)
    clearSharedReads()
  })

  ipcMain.handle('repo:base', async (_e, repo: unknown) => {
    assertPath(repo)
    return store.repoBases[await mainWorktreeRoot(repo)] ?? null
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

  ipcMain.handle('worktree:list', async (_e, repo: unknown) => {
    assertPath(repo)
    // Git cannot say it: a deleted repo lists nothing, and what runs in it becomes orphans.
    const list = await access(repo).then(() => cachedWorktrees(repo), (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    orphans.observe(repo, list)
    return list
  })

  ipcMain.handle('worktree:orphans', (_e, root: unknown) => {
    assertPath(root)
    return orphans.orphansUnder(root, live)
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
    const risks = await removalRisks(path, (await cachedBaseRef(repo)).ref)
    return { ...risks, sessions: live.sessions(path), terminals: live.terminals(path) }
  })

  ipcMain.handle('worktree:remove', async (_e, repo: unknown, path: unknown, force: unknown) => {
    assertPath(repo)
    assertPath(path)
    await removeAndStop(repo, path, force === true, live, removeWorktree)
    clearSharedReads()
  })
}
