import { useEffect } from 'react'
import { testPR, toggleTerminals, useTerminals } from './terminalStore'

/** « Terminal » and « Tester la PR », and the ⌃` shortcut of the panel. */
export function TerminalControls(props: { cwd: string }): React.JSX.Element {
  const open = useTerminals((s) => s.open)

  useEffect(() => {
    // Captured before xterm, which would send the key to the shell.
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault()
        e.stopPropagation()
        // Asking for the terminal is the one case where it should take the keys.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        toggleTerminals()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="term-controls">
      <button className="secondary" aria-pressed={open} onClick={toggleTerminals}>
        Terminal <span className="mono kbd">⌃`</span>
      </button>
      <button className="primary" onClick={() => void testPR(props.cwd)}>Tester la PR</button>
    </div>
  )
}
