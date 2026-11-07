/// <reference types="vite/client" />
import type { CanopyApi } from '../shared/api'

declare global {
  interface Window {
    canopy: CanopyApi
  }
}
