import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/update'
import { bannerText } from './updateText'

/** Keeps the button disabled while the main process asks, and gives it back once the user cancels. */
export function requestRestart(setAsked: (asked: boolean) => void, restart: () => Promise<void>): void {
  setAsked(true)
  void restart().catch(() => {}).finally(() => setAsked(false))
}

/** The update notice above the header. It cannot be closed: the restart is coming either way. */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'none' })
  const [now, setNow] = useState(Date.now())
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    // An event that lands before the first answer is the fresher of the two.
    let fresh = false
    const off = window.canopy.on('update:state', (s) => { fresh = true; setState(s as UpdateState); setAsked(false) })
    void window.canopy.updateState().then((s) => { if (!fresh) setState(s) })
    return off
  }, [])

  // The countdown moves every second; "à HH:MM" must turn into "demain à HH:MM" and back across midnight.
  useEffect(() => {
    if (state.phase === 'none') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), state.phase === 'warning' ? 1000 : 60_000)
    return () => clearInterval(t)
  }, [state])

  const text = bannerText(state, now)
  if (!text) return null
  const warning = state.phase === 'warning'
  return (
    <div className="update-banner" data-phase={state.phase} role="status" data-testid="update-banner">
      <span>{text}</span>
      <button disabled={asked} onClick={() => requestRestart(setAsked, () => window.canopy.restartToUpdate())}>
        {warning ? 'Redémarrer maintenant' : 'Redémarrer'}
      </button>
    </div>
  )
}
