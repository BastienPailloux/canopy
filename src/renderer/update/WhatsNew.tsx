import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ReleaseNotes } from '../../shared/update'
import { useModal } from '../shell/useModal'
import { openRestored } from './openRestored'
import { useStillUnsaved } from './stash'

/** Open at launch; the restored-files chip opens it again. */
const usePanel = create<{ open: boolean }>(() => ({ open: true }))

/** The path as the worktree shows it: relative to `cwd` when inside it. */
const relative = (cwd: string, path: string): string =>
  path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path

function Items(props: { title: string; items: string[] }): React.JSX.Element | null {
  if (props.items.length === 0) return null
  return (
    <>
      <h3>{props.title}</h3>
      <ul>{props.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </>
  )
}

/** After an update: what changed since the version last seen, and the unsaved files that came back. */
export function WhatsNew(): React.JSX.Element | null {
  const [notes, setNotes] = useState<ReleaseNotes[]>([])
  const open = usePanel((s) => s.open)
  const files = useStillUnsaved()

  useEffect(() => {
    let live = true
    window.canopy.whatsNew().then((n) => { if (live) setNotes(n) }, () => {})
    return () => { live = false }
  }, [])

  if (!open || (notes.length === 0 && files.length === 0)) return null

  // The notes are read once; the restored files stay reachable from the chip until each is saved or dropped.
  const close = (): void => {
    if (notes.length > 0) {
      void window.canopy.markWhatsNewSeen().catch(() => {})
      setNotes([])
    }
    usePanel.setState({ open: false })
  }
  const openFile = (cwd: string, path: string): void => { void openRestored(cwd, path) }

  const title = notes.length > 0 ? `Quoi de neuf dans ${notes[0].version}` : 'Récupéré après la mise à jour'
  return <WhatsNewDialog title={title} notes={notes} files={files} openFile={openFile} close={close} />
}

function WhatsNewDialog(props: {
  title: string
  notes: ReleaseNotes[]
  files: { cwd: string; path: string }[]
  openFile: (cwd: string, path: string) => void
  close: () => void
}): React.JSX.Element {
  const { title, notes, files, openFile, close } = props
  const dialog = useRef<HTMLDivElement>(null)
  useModal(dialog, close)
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div ref={dialog} className="dialog whats-new" role="dialog" aria-modal="true" aria-label={title} data-testid="whats-new">
        <h2>{title}</h2>
        <div className="whats-new-body">
          {notes.map((n) => (
            <section key={n.version}>
              {notes.length > 1 && <h3 className="version">{n.version}</h3>}
              <Items title="Nouveautés" items={n.features} />
              <Items title="Corrections" items={n.fixes} />
            </section>
          ))}
          {files.length > 0 && (
            <section>
              {notes.length > 0 && <h3>Récupéré après la mise à jour</h3>}
              <ul className="restored">
                {files.map((f) => (
                  <li key={f.cwd + '\0' + f.path}>
                    <button className="link mono" onClick={() => openFile(f.cwd, f.path)}>{relative(f.cwd, f.path)}</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className="actions">
          <button className="secondary" onClick={close} autoFocus>Fermer</button>
        </div>
      </div>
    </div>
  )
}

/** Keeps the restored files reachable once the panel is closed. Not dismissible: it goes as the files get saved. */
export function RestoredChip(): React.JSX.Element | null {
  const files = useStillUnsaved()
  if (files.length === 0) return null
  const n = files.length
  return (
    <div className="restored-chip" data-testid="restored-chip">
      <button onClick={() => usePanel.setState({ open: true })}>
        {n} {n > 1 ? 'fichiers récupérés' : 'fichier récupéré'} après la mise à jour
      </button>
    </div>
  )
}
