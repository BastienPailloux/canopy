import { useEffect, useState } from 'react'
import type { SwitchInfo } from '../../shared/api'
import type { Worktree } from '../../shared/types'
import { worktreeLabel } from '../store'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Says what the switch sets aside and what it runs under, and waits for the branch to go to. */
export function SwitchBranchDialog(props: { worktree: Worktree; onSwitched: () => void; onClose: () => void }): React.JSX.Element {
  const { worktree } = props
  const [info, setInfo] = useState<SwitchInfo | null>(null)
  const [branch, setBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    let live = true
    window.canopy.switchInfo(worktree.path).then(
      (i) => { if (live) { setInfo(i); setBranch(i.branches[0] ?? '') } },
      (e: unknown) => { if (live) setError(message(e)) }
    )
    return () => { live = false }
  }, [worktree.path])

  const confirm = async (): Promise<void> => {
    if (branch === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.canopy.switchBranch(worktree.path, branch)
      props.onSwitched()
      if (result.conflict) setConflict(true)
      else props.onClose()
    } catch (e) {
      setError(message(e))
    }
    setBusy(false)
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) props.onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Changer de branche"
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) props.onClose() }}>
        <h2>Changer de branche</h2>
        <span className="mono">{worktreeLabel(worktree)}</span>
        {conflict ? (
          <p className="risk" role="alert" data-testid="switch-conflict">
            Branche changée, mais ses modifications mises de côté sont en conflit. Résolvez-le dans les fichiers : elles restent aussi dans git stash.
          </p>
        ) : (
          <>
            {info === null && error === null && <span style={{ color: 'var(--fg-2)' }}>Lecture des branches…</span>}
            {info && info.branches.length === 0 && <span style={{ color: 'var(--fg-2)' }}>Aucune autre branche disponible : les autres sont ouvertes dans un worktree.</span>}
            {info && info.branches.length > 0 && (
              <label>
                Branche
                <select aria-label="Branche" className="mono" autoFocus value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {info.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            )}
            {info && info.dirty > 0 && (
              <span style={{ color: 'var(--fg-2)' }} data-testid="switch-dirty">
                {info.dirty} fichier{info.dirty > 1 ? 's' : ''} modifié{info.dirty > 1 ? 's' : ''} mis de côté, réappliqué{info.dirty > 1 ? 's' : ''} au retour sur cette branche.
              </span>
            )}
            {info && info.sessions > 0 && (
              <p className="risk" data-testid="switch-sessions">
                Attention : {info.sessions} session{info.sessions > 1 ? 's' : ''} active{info.sessions > 1 ? 's' : ''} dans ce dossier : les fichiers vont changer sous {info.sessions > 1 ? 'elles' : 'elle'}.
              </p>
            )}
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="secondary" onClick={props.onClose} disabled={busy}>{conflict ? 'Fermer' : 'Annuler'}</button>
          {!conflict && (
            <button className="primary" onClick={() => void confirm()} disabled={branch === '' || busy}>
              {busy ? 'Changement…' : info && info.sessions > 0 ? 'Changer quand même' : 'Changer'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
