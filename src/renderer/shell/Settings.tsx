import { useEffect, useState } from 'react'
import { ACCOUNT_CHANGED } from './AccountFooter'

interface KeyStatus { set: boolean; encryptionAvailable: boolean }

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

/** Settings: the API key, which goes to the keychain and is never shown again, and the repos trusted so far. */
export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [trusted, setTrusted] = useState<string[]>([])

  useEffect(() => {
    window.canopy.apiKeyStatus().then(setStatus, (e: unknown) => setError(errorText(e)))
    window.canopy.trustedRepos().then(setTrusted, (e: unknown) => setError(errorText(e)))
  }, [])

  const revoke = async (root: string): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      await window.canopy.revokeRepo(root)
      setTrusted(await window.canopy.trustedRepos())
      setNotice('Confiance retirée : la prochaine session redemandera.')
    } catch (e) {
      setError(errorText(e))
    }
  }

  const save = async (value: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await window.canopy.saveApiKey(value)
      setKey('')
      window.dispatchEvent(new Event(ACCOUNT_CHANGED))
      setStatus(await window.canopy.apiKeyStatus())
      setNotice(value === null ? 'Clé supprimée.' : 'Clé enregistrée dans le trousseau.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const trimmed = key.trim()
  const canStore = status?.encryptionAvailable !== false

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label="Réglages"
        onSubmit={(e) => { e.preventDefault(); if (trimmed !== '' && !busy) void save(trimmed) }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <h2>Réglages</h2>
        <label>
          Clé API Anthropic
          <input autoFocus type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={status?.set ? '•••••••• (enregistrée)' : 'sk-ant-…'} spellCheck={false} disabled={!canStore} />
        </label>
        <span data-testid="key-status" style={{ color: 'var(--fg-3)', fontSize: 12, lineHeight: 1.5 }}>
          {status?.set
            ? 'Une clé est enregistrée : les nouvelles sessions l’utilisent à la place de ton login Claude.'
            : 'Aucune clé : les sessions utilisent ton login Claude personnel.'}
        </span>
        {!canStore && (
          <p className="risk" role="alert">
            Le trousseau macOS n’est pas disponible : Canopy ne stocke jamais une clé en clair, elle ne peut pas être enregistrée.
          </p>
        )}
        {trusted.length > 0 && (
          <div className="trusted-repos">
            <span className="title">Dépôts approuvés</span>
            {trusted.map((root) => (
              <span key={root} className="trusted-repo">
                <span className="mono path" title={root}>{root}</span>
                <button type="button" className="secondary" aria-label={`Révoquer ${root}`} onClick={() => void revoke(root)}>Révoquer</button>
              </span>
            ))}
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <span role="status" style={{ color: 'var(--add)', fontSize: 12 }}>{notice}</span>}
        <div className="actions">
          {status?.set && <button type="button" className="secondary" disabled={busy} onClick={() => void save(null)}>Supprimer la clé</button>}
          <button type="button" className="secondary" onClick={onClose}>Fermer</button>
          <button type="submit" className="primary" disabled={trimmed === '' || busy || !canStore}>Enregistrer</button>
        </div>
      </form>
    </div>
  )
}
