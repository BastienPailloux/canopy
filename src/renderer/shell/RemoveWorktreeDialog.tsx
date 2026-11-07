import { useEffect, useState } from 'react'
import type { RemovalRisks } from '../../shared/api'
import type { Worktree } from '../../shared/types'
import { worktreeLabel } from '../store'
import { removalWarnings } from './removalText'

/** Always shows the removal risks and waits for confirmation before removing. */
export function RemoveWorktreeDialog(props: {
  repo: string
  worktree: Worktree
  onRemoved: () => void
  onClose: () => void
}): React.JSX.Element {
  const { repo, worktree } = props
  const [risks, setRisks] = useState<RemovalRisks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.canopy.removalRisks(repo, worktree.path).then(
      (r) => { if (live) setRisks(r) },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) }
    )
    return () => { live = false }
  }, [repo, worktree.path])

  const warnings = risks ? removalWarnings(risks, worktreeLabel(worktree)) : []

  const confirm = async (): Promise<void> => {
    if (!risks || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.canopy.removeWorktree(repo, worktree.path, risks.dirty > 0)
      props.onRemoved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) props.onClose() }}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label="Supprimer le worktree"
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) props.onClose() }}>
        <h2>Supprimer ce worktree ?</h2>
        <span className="mono">{worktreeLabel(worktree)}</span>
        {risks === null && error === null && <span style={{ color: 'var(--fg-2)' }}>Vérification des risques…</span>}
        {warnings.length > 0 && (
          <p className="risk" data-testid="removal-risk">
            Attention : {warnings.join(' ')}
          </p>
        )}
        {risks && warnings.length === 0 && <span style={{ color: 'var(--fg-2)' }}>Aucun travail non sauvegardé détecté.</span>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="secondary" onClick={props.onClose} disabled={busy} autoFocus>Annuler</button>
          <button className="danger" onClick={() => void confirm()} disabled={!risks || busy}>
            {busy ? 'Suppression…' : warnings.length > 0 ? 'Supprimer quand même' : 'Supprimer'}
          </button>
        </div>
      </div>
    </div>
  )
}
