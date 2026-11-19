import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaptureBridge } from '../../shared/capture'
import { Panel } from './Panel'
import { Selector } from './Selector'
import { startWorker } from './worker'
import './capture.css'

// Exposed by the capture preload only; the app's env.d.ts types `window.canopy`, absent here.
const bridge = (window as unknown as { captureBridge: CaptureBridge }).captureBridge

if (bridge.role === 'worker') startWorker(bridge)
else if (bridge.role) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {bridge.role === 'select' ? <Selector bridge={bridge} /> : <Panel bridge={bridge} />}
    </StrictMode>
  )
}
