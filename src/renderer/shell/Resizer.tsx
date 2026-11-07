import { useRef } from 'react'

const STEP = 16

/**
 * The draggable edge of a panel. `onDrag` gets the pointer's distance from where the drag began;
 * the arrow keys move it by a step, a double click asks for the default width.
 */
export function Resizer(props: { label: string; value: number; onDragStart: () => void; onDrag: (dx: number) => void; onStep: (dx: number) => void; onReset: () => void }): React.JSX.Element {
  const start = useRef<number | null>(null)
  return (
    <div className="resizer" role="separator" aria-orientation="vertical" aria-label={props.label} aria-valuenow={Math.round(props.value)}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = e.clientX
        props.onDragStart()
        document.body.classList.add('resizing')
      }}
      onPointerMove={(e) => { if (start.current !== null) props.onDrag(e.clientX - start.current) }}
      onPointerUp={() => { start.current = null; document.body.classList.remove('resizing') }}
      onLostPointerCapture={() => { start.current = null; document.body.classList.remove('resizing') }}
      onDoubleClick={props.onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          props.onStep(e.key === 'ArrowLeft' ? -STEP : STEP)
        }
      }} />
  )
}
