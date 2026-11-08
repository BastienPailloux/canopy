import { useEffect, useRef, useState } from 'react'
import type { MockupViewBounds, MockupViewErrorEvent } from '../../shared/mockups'

const MODAL = '[aria-modal="true"]'

/**
 * The area the main process draws the claude.ai view on. The native view sits above the page: it is shown on this
 * element's rectangle, follows it on every layout change, hides while a modal is open and when this unmounts.
 * `url` null: nothing to show yet, `children` take the place.
 */
export function MockupWebView(props: { url: string | null; children?: React.ReactNode }): React.JSX.Element {
  const { url } = props
  const area = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<{ url: string; text: string } | null>(null)

  useEffect(() => {
    const el = area.current
    if (!el || !url) return
    let shown = false
    let last = ''
    let frame = 0
    const sync = (): void => {
      frame = 0
      const r = el.getBoundingClientRect()
      if (document.querySelector(MODAL) || r.width < 1 || r.height < 1) {
        if (shown) { shown = false; void window.canopy.hideMockupView().catch(() => undefined) }
        return
      }
      const b: MockupViewBounds = { x: r.left, y: r.top, width: r.width, height: r.height }
      const key = `${b.x},${b.y},${b.width},${b.height}`
      if (!shown) {
        shown = true
        last = key
        window.canopy.showMockupView(url, b).catch((e: unknown) => setError({ url, text: e instanceof Error ? e.message : String(e) }))
      } else if (key !== last) {
        last = key
        void window.canopy.setMockupViewBounds(b).catch(() => undefined)
      }
    }
    // Layout settles once per frame: one measure per frame, whatever changed.
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(sync) }
    sync()
    const resize = new ResizeObserver(schedule)
    resize.observe(el)
    resize.observe(document.body)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      void window.canopy.hideMockupView().catch(() => undefined)
    }
  }, [url])

  useEffect(() => window.canopy.on('mockups:viewError', (p) => {
    const e = p as MockupViewErrorEvent
    if (e.url === url) setError({ url: e.url, text: e.error })
  }), [url])

  const failed = error && error.url === url ? error.text : null
  const reload = (): void => {
    setError(null)
    void window.canopy.reloadMockupView().catch(() => undefined)
  }

  return (
    <div className="mockup-view-wrap">
      {failed && (
        <div className="mockup-view-error" role="alert">
          <span>La maquette n’a pas pu se charger : {failed}</span>
          <button className="secondary" onClick={reload}>Recharger</button>
        </div>
      )}
      <div ref={area} className="mockup-view" data-testid="mockup-view">{!url && props.children}</div>
    </div>
  )
}
