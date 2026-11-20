import { useEffect, useRef, useState } from 'react'
import type { CaptureBridge } from '../../shared/capture'
import type { Rect } from '../../shared/captureGeometry'

/** The veil over one display. Main turns the drag into a region (clamped to this display); a click takes the whole display. */
export function Selector({ bridge }: { bridge: CaptureBridge }): React.JSX.Element {
  const start = useRef<{ x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<Rect | null>(null)
  const sent = useRef(false)

  const send = (r: Rect | null): void => {
    if (sent.current) return
    sent.current = true
    bridge.select(r)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') send(null) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const toRect = (e: React.PointerEvent): Rect | null =>
    start.current && { x: start.current.x, y: start.current.y, width: e.clientX - start.current.x, height: e.clientY - start.current.y }

  // Shown normalized; main normalizes again, the page is never trusted with the region.
  const box = drag && {
    left: Math.min(drag.x, drag.x + drag.width),
    top: Math.min(drag.y, drag.y + drag.height),
    width: Math.abs(drag.width),
    height: Math.abs(drag.height)
  }

  return (
    <div
      className={`capture-veil${box ? ' dragging' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, y: e.clientY }
        setDrag({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
      }}
      onPointerMove={(e) => { if (start.current) setDrag(toRect(e)) }}
      onPointerUp={(e) => {
        const r = toRect(e)
        start.current = null
        if (r) send(r)
      }}
    >
      {box ? <div className="capture-box" style={box} /> : (
        <div className="capture-hint">Glisse pour choisir une zone, clique pour prendre l'écran entier. Échap pour annuler.</div>
      )}
    </div>
  )
}
