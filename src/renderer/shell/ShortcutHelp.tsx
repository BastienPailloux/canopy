import { useRef } from 'react'
import { displayKeys, SHORTCUTS, type ShortcutId } from '../../shared/shortcuts'
import { useApp } from '../store'
import { useModal } from './useModal'

interface Row { keys: string; label: string }

const GROUPS: { title: string; ids: ShortcutId[]; extra?: Row[] }[] = [
  { title: 'Écrans', ids: ['view-sessions', 'view-code', 'view-tickets', 'view-mockups'] },
  { title: 'Worktrees et sessions', ids: ['worktree-next', 'worktree-previous', 'new-worktree', 'new-session'], extra: [{ keys: '⌘W', label: "Fermer l'onglet" }] },
  { title: 'Tickets', ids: ['new-ticket'] },
  {
    title: 'Saisie et recherche',
    ids: ['dictation'],
    extra: [
      { keys: '⌘↵', label: 'Envoyer' },
      { keys: '⌘K', label: 'Rechercher' },
      { keys: '⌘P', label: 'Ouvrir un fichier (Code)' },
      { keys: '⇧⌘F', label: 'Rechercher dans les fichiers (Code)' },
      { keys: '⌃`', label: 'Terminal' }
    ]
  },
  { title: 'Aide', ids: ['help'] }
]

const rowsOf = (ids: ShortcutId[]): Row[] =>
  ids.flatMap((id) => SHORTCUTS.filter((s) => s.id === id).map((s) => ({ keys: displayKeys(s.accelerator), label: s.label })))

/** ⇧⌘H: every shortcut, read from the same table as the menu. */
export function ShortcutHelp(): React.JSX.Element {
  const setDialog = useApp((s) => s.setDialog)
  const close = (): void => setDialog(null)
  const dialog = useRef<HTMLDivElement>(null)
  useModal(dialog, close)
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div ref={dialog} className="dialog shortcut-help" role="dialog" aria-modal="true" aria-label="Raccourcis clavier" tabIndex={-1}>
        <h2>Raccourcis clavier</h2>
        {GROUPS.map((g) => (
          <table key={g.title}>
            <caption>{g.title}</caption>
            <tbody>
              {[...rowsOf(g.ids), ...(g.extra ?? [])].map((r) => (
                <tr key={r.keys}><td className="keys mono">{r.keys}</td><td>{r.label}</td></tr>
              ))}
            </tbody>
          </table>
        ))}
        <div className="actions">
          <button type="button" className="primary" onClick={close}>Fermer</button>
        </div>
      </div>
    </div>
  )
}
