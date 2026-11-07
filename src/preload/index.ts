import { contextBridge } from 'electron'
import type { CanopyApi } from '../shared/api'

const api: CanopyApi = {}

contextBridge.exposeInMainWorld('canopy', api)
