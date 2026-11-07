import { useState } from 'react'

export function NewWorktreeDialog(props: {
  repo: string
  onCreated: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = branch.trim()
  const invalid = trimmed === '' || /\s/.test(trimmed)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (invalid || busy) return
    setBusy(true)
    setError(null)
    try {
      // Folder name: the branch with its slashes flattened.
      const wt = await window.canopy.createWorktree(props.repo, { name: trimmed.replace(/\//g, '-'), branch: trimmed })
      props.onCreated(wt.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) props.onClose() }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label="Nouveau worktree" onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) props.onClose() }}>
        <h2>Nouveau worktree</h2>
        <label>
          Nom de la branche
          <input autoFocus value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/ma-fonctionnalité" spellCheck={false} />
        </label>
        <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>Créé dans .worktrees/ à partir de la branche par défaut.</span>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={props.onClose} disabled={busy}>Annuler</button>
          <button type="submit" className="primary" disabled={invalid || busy}>{busy ? 'Création…' : 'Créer'}</button>
        </div>
      </form>
    </div>
  )
}
