import { useRef } from 'react'
import { useModal } from '../shell/useModal'
import { useSessions } from './sessionStore'

const COPY = {
  screen: {
    title: "Autoriser l'enregistrement de l'écran",
    body: "Canopy a besoin de cette permission pour capturer une zone de l'écran et la joindre à ton message. Après l'avoir accordée dans les Réglages Système, relance Canopy.",
    dismiss: 'Annuler'
  },
  // Clicks need no permission of their own (CLICK_PERMISSION 'none'), so only a failed helper lands here: neutral copy, Accessibility as the likeliest fix.
  clicks: {
    title: 'Clics non enregistrés',
    body: "Les clics n'ont pas pu être enregistrés pour cet enregistrement. Si ça se reproduit, autorise Canopy dans les Réglages Système (Accessibilité). L'enregistrement fonctionne sans, sans les clics.",
    dismiss: 'Plus tard'
  }
} as const

/** Explains the permission a capture lacked, with a way to the right System Settings pane. */
export function CaptureDialog(): React.JSX.Element | null {
  const which = useSessions((s) => s.captureDialog)
  return which ? <CapturePrompt which={which} /> : null
}

function CapturePrompt({ which }: { which: 'screen' | 'clicks' }): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const close = (): void => useSessions.setState({ captureDialog: null })
  useModal(dialog, close)
  const { title, body, dismiss } = COPY[which]
  const open = (): void => {
    close()
    void window.canopy.openCaptureSettings(which).catch(() => undefined)
  }
  return (
    <div className="overlay">
      <div className="dialog capture-dialog" ref={dialog} tabIndex={-1} role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="actions">
          <button type="button" className="secondary" onClick={close}>{dismiss}</button>
          <button type="button" className="primary" onClick={open}>Ouvrir les Réglages Système</button>
        </div>
      </div>
    </div>
  )
}
