import { contextBridge, ipcRenderer } from 'electron'
import type { CanopyApi } from '../shared/api'

const EVENT_CHANNEL = 'canopy:event'

const api: CanopyApi = {
  openRepo: () => ipcRenderer.invoke('repo:open'),
  selectRepo: (path) => ipcRenderer.invoke('repo:select', path),
  recentRepos: () => ipcRenderer.invoke('repo:recent'),
  listWorktrees: (repo) => ipcRenderer.invoke('worktree:list', repo),
  worktreeStats: (cwd) => ipcRenderer.invoke('worktree:stats', cwd),
  createWorktree: (repo, o) => ipcRenderer.invoke('worktree:create', repo, o),
  removalRisks: (repo, path) => ipcRenderer.invoke('worktree:risks', repo, path),
  removeWorktree: (repo, path, force) => ipcRenderer.invoke('worktree:remove', repo, path, force),
  on(event, cb) {
    const listener = (_e: Electron.IpcRendererEvent, name: string, payload: unknown): void => {
      if (name === event) cb(payload)
    }
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => { ipcRenderer.removeListener(EVENT_CHANNEL, listener) }
  }
}

contextBridge.exposeInMainWorld('canopy', api)
