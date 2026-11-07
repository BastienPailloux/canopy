import { useEffect, useRef, useState } from 'react'
import type { BaseRef } from '../../shared/types'
import { useModal } from './useModal'

/** Folder name of a branch: without its remote, its slashes flattened. */
const folderName = (branch: string): string => branch.replace(/^origin\//, '').replace(/\//g, '-')

/** A new branch from a base of the user's choice, or a branch that exists; in `.worktrees/` unless told otherwise. */
export function NewWorktreeDialog(props: {
  repo: string
  onCreated: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [existing, setExisting] = useState(false)
  const [branch, setBranch] = useState('')
  const [picked, setPicked] = useState('')
  const [base, setBase] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBase, setDefaultBase] = useState<BaseRef | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([window.canopy.codeBranches(props.repo).catch((): string[] => []), window.canopy.defaultBase(props.repo).catch(() => null)])
      .then(([list, ref]) => {
        if (!live) return
        setBranches(list)
        setDefaultBase(ref)
      })
    return () => { live = false }
  }, [props.repo])

  const trimmed = branch.trim()
  const location = parentDir.trim()
  const chosen = existing ? picked : trimmed
  const invalid = chosen === '' || /\s/.test(chosen) || (!existing && base === '' && !defaultBase) || (location !== '' && !location.startsWith('/'))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (invalid || busy) return
    setBusy(true)
    setError(null)
    try {
      const wt = await window.canopy.createWorktree(props.repo, {
        name: folderName(chosen),
        branch: chosen,
        ...(existing ? { existing: true } : base !== '' ? { base } : {}),
        ...(location !== '' ? { parentDir: location } : {})
      })
      props.onCreated(wt.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const dialog = useRef<HTMLFormElement>(null)
  useModal(dialog, () => { if (!busy) props.onClose() })

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) props.onClose() }}>
      <form ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-label="Nouveau worktree" onSubmit={(e) => void submit(e)}>
        <h2>Nouveau worktree</h2>
        <label className="check">
          <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />
          Utiliser une branche existante
        </label>
        {existing ? (
          <label>
            Branche
            <select autoFocus aria-label="Branche" className="mono" value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="" disabled>Choisir une branche…</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        ) : (
          <>
            <label>
              Nom de la branche
              <input autoFocus value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/ma-fonctionnalité" spellCheck={false} />
            </label>
            <label>
              Base
              <select aria-label="Base" className="mono" value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="" disabled={!defaultBase}>{defaultBase ? `Par défaut (${defaultBase.ref})` : 'Choisir une base…'}</option>
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          </>
        )}
        <label>
          Emplacement
          <input value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder={`${props.repo}/.worktrees`} spellCheck={false} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={props.onClose} disabled={busy}>Annuler</button>
          <button type="submit" className="primary" disabled={invalid || busy}>{busy ? 'Création…' : 'Créer'}</button>
        </div>
      </form>
    </div>
  )
}
