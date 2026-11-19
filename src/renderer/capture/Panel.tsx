import { useEffect, useState } from 'react'
import type { CaptureBridge } from '../../shared/capture'
import { formatPanelTime } from './panelTime'

/** The floating recording panel; main owns the real timer, this one only shows it. */
export function Panel({ bridge }: { bridge: CaptureBridge }): React.JSX.Element {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const h = setInterval(() => { setNow(Date.now()) }, 250)
    return () => { clearInterval(h) }
  }, [])
  const { text, warning } = formatPanelTime(now - startedAt)
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
