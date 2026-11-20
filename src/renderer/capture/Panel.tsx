import { useEffect, useState } from 'react'
import type { CaptureBridge } from '../../shared/capture'
import { formatPanelTime, panelElapsed } from './panelTime'

/** The floating recording panel; main owns the real timer, this one only shows it. */
export function Panel({ bridge }: { bridge: CaptureBridge }): React.JSX.Element {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    bridge.onStarted((at) => { setStartedAt(at); setNow(Date.now()) })
    // Main sends the start only once it hears this: a start sent earlier would be lost.
    bridge.ready()
  }, [bridge])
  useEffect(() => {
    const h = setInterval(() => { setNow(Date.now()) }, 250)
    return () => { clearInterval(h) }
  }, [])
  const { text, warning } = formatPanelTime(panelElapsed(startedAt, now))
  return (
    <div className="capture-panel">
      <span className="capture-dot" />
      <span className={`capture-time${warning ? ' warning' : ''}`}>{text}</span>
      <button type="button" className="capture-stop" onClick={() => { bridge.stop() }}>
        <span className="capture-square" />Arrêter
      </button>
    </div>
  )
}
