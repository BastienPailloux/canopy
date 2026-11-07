import { contextBridge, ipcRenderer } from 'electron'
import type { CanopyApi } from '../shared/api'

const EVENT_CHANNEL = 'canopy:event'

const api: CanopyApi = {
  openRepo: () => ipcRenderer.invoke('repo:open'),
  selectRepo: (path) => ipcRenderer.invoke('repo:select', path),
  recentRepos: () => ipcRenderer.invoke('repo:recent'),
  listWorktrees: (repo) => ipcRenderer.invoke('worktree:list', repo),
  worktreeStats: (cwd) => ipcRenderer.invoke('worktree:stats', cwd),
  worktreeStatus: (cwd, onFocus) => ipcRenderer.invoke('worktree:status', cwd, onFocus),
  repoNeedsAttention: (repo) => ipcRenderer.invoke('repo:needsAttention', repo),
  apiKeyStatus: () => ipcRenderer.invoke('settings:apiKeyStatus'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:saveApiKey', key),
  createWorktree: (repo, o) => ipcRenderer.invoke('worktree:create', repo, o),
  defaultBase: (cwd) => ipcRenderer.invoke('worktree:defaultBase', cwd),
  removalRisks: (repo, path) => ipcRenderer.invoke('worktree:risks', repo, path),
  removeWorktree: (repo, path, force) => ipcRenderer.invoke('worktree:remove', repo, path, force),
  orphanedWorktrees: (repo) => ipcRenderer.invoke('worktree:orphans', repo),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  listTree: (cwd) => ipcRenderer.invoke('code:listTree', cwd),
  searchText: (cwd, q, o) => ipcRenderer.invoke('code:search', cwd, q, o),
  definition: (cwd, path, line, column) => ipcRenderer.invoke('code:definition', cwd, path, line, column),
  references: (cwd, path, line, column) => ipcRenderer.invoke('code:references', cwd, path, line, column),
  symbols: (cwd, q) => ipcRenderer.invoke('code:symbols', cwd, q),
  codeChanges: (cwd, base) => ipcRenderer.invoke('code:changes', cwd, base),
  codeBranches: (cwd) => ipcRenderer.invoke('code:branches', cwd),
  readBase: (cwd, base, path) => ipcRenderer.invoke('code:readBase', cwd, base, path),
  readFile: (cwd, path) => ipcRenderer.invoke('code:readFile', cwd, path),
  writeFile: (cwd, path, content, expectedVersion) => ipcRenderer.invoke('code:writeFile', cwd, path, content, expectedVersion),
  watchWorktrees: (repo) => ipcRenderer.invoke('code:watch', repo),
  repoTrust: (cwd) => ipcRenderer.invoke('repo:trust', cwd),
  trustRepo: (cwd, configHash) => ipcRenderer.invoke('repo:trustRepo', cwd, configHash),
  startSession: (cwd, o) => ipcRenderer.invoke('session:start', cwd, o),
  sendToSession: (localId, content) => ipcRenderer.invoke('session:send', localId, content),
  interruptSession: (localId) => ipcRenderer.invoke('session:interrupt', localId),
  setSessionMode: (localId, mode) => ipcRenderer.invoke('session:setMode', localId, mode),
  setSessionModel: (localId, model) => ipcRenderer.invoke('session:setModel', localId, model),
  stopSession: (localId) => ipcRenderer.invoke('session:stop', localId),
  resolvePermission: (requestId, decision) => ipcRenderer.invoke('session:resolvePermission', requestId, decision),
  listSessions: (cwd) => ipcRenderer.invoke('session:list', cwd),
  sessionHistory: (cwd, sessionId) => ipcRenderer.invoke('session:history', cwd, sessionId),
  sessionActivity: (cwd) => ipcRenderer.invoke('session:activity', cwd),
  sessionCommands: (localId) => ipcRenderer.invoke('session:commands', localId),
  sessionModels: (localId) => ipcRenderer.invoke('session:models', localId),
  pendingPermissions: () => ipcRenderer.invoke('session:pendingPermissions'),
  createTerminal: (cwd) => ipcRenderer.invoke('terminal:create', cwd),
  listTerminals: (cwd) => ipcRenderer.invoke('terminal:list', cwd),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),
  removeTerminal: (id) => ipcRenderer.invoke('terminal:remove', id),
  terminalSnapshot: (id) => ipcRenderer.invoke('terminal:snapshot', id),
  runSetup: (cwd) => ipcRenderer.invoke('terminal:runSetup', cwd),
  runServices: (cwd, name) => ipcRenderer.invoke('terminal:runServices', cwd, name),
  on(event, cb) {
    const listener = (_e: Electron.IpcRendererEvent, name: string, payload: unknown): void => {
      if (name === event) cb(payload)
    }
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => { ipcRenderer.removeListener(EVENT_CHANNEL, listener) }
  }
}

contextBridge.exposeInMainWorld('canopy', api)
