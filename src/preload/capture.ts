import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureBridge, CapturePageRole } from '../shared/capture'

const ROLES: CapturePageRole[] = ['select', 'panel', 'worker']
const asked = new URLSearchParams(window.location.search).get('role')

// Capture pages get this alone, never CanopyApi: they only report a region, a stop or frames.
const bridge: CaptureBridge = {
  role: ROLES.find(r => r === asked) ?? null,
  select: (drag) => { ipcRenderer.send('capture-page:select', drag) },
  stop: () => { ipcRenderer.send('capture-page:stop') },
  ready: () => { ipcRenderer.send('capture-page:ready') },
  onJob: (fn) => { ipcRenderer.on('capture-page:job', (_e, job) => { fn(job) }) },
  onFinish: (fn) => { ipcRenderer.on('capture-page:finish', (_e, f) => { fn(f) }) },
  result: (r) => { ipcRenderer.send('capture-page:result', r) }
}

contextBridge.exposeInMainWorld('captureBridge', bridge)
