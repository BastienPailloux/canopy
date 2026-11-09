import { useEffect, useRef, useState } from 'react'
import { PREFIX_RE } from '../../shared/tickets'
import { useApp } from '../store'
import { ACCOUNT_CHANGED } from './AccountFooter'
import { useLinear } from '../tickets/linearStore'
import type { LinearConnection } from '../../shared/linear'
import { useModal } from './useModal'
import { TemplatesDialog } from '../tickets/TemplatesDialog'

interface KeyStatus { set: boolean; encryptionAvailable: boolean; readable: boolean }

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

const PENDING_MESSAGE = /Des modifications Linear n.ont pas été envoyées/

/** The Linear connection: connect, who is connected, reconnect when expired, disconnect (asking when edits are unsent). */
function LinearSettings(): React.JSX.Element {
  return <LinearSettingsView connection={useLinear((s) => s.connection)} />
}

export function LinearSettingsView({ connection }: { connection: LinearConnection }): React.JSX.Element {
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    window.canopy.linearConnection().then((c) => useLinear.setState({ connection: c }), () => undefined)
  }, [])

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setError(null)
    try {
      useLinear.setState({ connection: await window.canopy.linearConnect() })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setConnecting(false)
    }
  }
  const disconnect = async (force?: boolean): Promise<void> => {
    setError(null)
    try {
      await window.canopy.linearDisconnect(force)
      setConfirming(false)
      useLinear.setState({ connection: await window.canopy.linearConnection() })
    } catch (e) {
      const text = errorText(e)
      if (!force && PENDING_MESSAGE.test(text)) setConfirming(true)
      else { setConfirming(false); setError(text) }
    }
  }

  const { state, workspace, email, missingTools } = connection
  const connectLabel = connecting ? 'Connexion…' : state === 'expired' ? 'Reconnecter' : 'Connecter Linear'
  return (
    <div className="linear-settings" data-testid="linear-settings">
      <span className="title">Linear</span>
      {state === 'connected' && <span data-testid="linear-account">{[workspace, email].filter(Boolean).join(' · ')}</span>}
      {state === 'expired' && <span className="linear-hint">Connexion Linear expirée.</span>}
      {/* Tokens are stored: Canopy tries them again on every refresh, nothing to connect. */}
      {state === 'offline' && <span className="linear-hint" role="status">{connection.error ?? 'Linear injoignable.'} Nouvel essai au prochain rafraîchissement.</span>}
      {state !== 'disconnected' && !confirming && (
        <button type="button" className="secondary" onClick={() => void disconnect()}>Déconnecter</button>
      )}
      {(state === 'disconnected' || state === 'expired') && (
        <>
          <button type="button" className="secondary" disabled={connecting} onClick={() => void connect()}>{connectLabel}</button>
          {state === 'disconnected' && <span className="linear-hint">Canopy demande la lecture et l'écriture sur ton espace Linear.</span>}
        </>
      )}
      {confirming && (
        <div role="alert" className="risk">
          <p>Des modifications Linear n’ont pas été envoyées. Déconnecter quand même ?</p>
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>Annuler</button>
          <button type="button" className="secondary" onClick={() => void disconnect(true)}>Déconnecter quand même</button>
        </div>
      )}
      {missingTools.length > 0 && (
        <span role="status" className="linear-warn">
          Linear a changé : outils manquants ({missingTools.join(', ')}). Certaines fonctions peuvent échouer.
        </span>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

/** Settings: the API key, which goes to the keychain and is never shown again, and the repos trusted so far. */
export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [trusted, setTrusted] = useState<string[]>([])

  const repo = useApp((st) => st.repo)
  const [saved, setSaved] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [prefixNotice, setPrefixNotice] = useState<string | null>(null)
  useEffect(() => {
    setSaved(null)
    setPrefix('')
    setPrefixNotice(null)
    if (!repo) return
    let current = true
    window.canopy.ticketConfig(repo).then(
      (c) => { if (current) { setSaved(c.prefix); setPrefix(c.prefix) } },
      (e: unknown) => { if (current) setError(errorText(e)) }
    )
    return () => { current = false }
  }, [repo])
  const prefixValid = PREFIX_RE.test(prefix)
  const savePrefix = async (): Promise<void> => {
    if (!repo || !prefixValid || prefix === saved) return
    setError(null)
    setPrefixNotice(null)
    try {
      await window.canopy.setTicketPrefix(repo, prefix)
      setSaved(prefix)
      setPrefixNotice('Préfixe enregistré.')
    } catch (e) {
      setError(errorText(e))
    }
  }

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

  const dialog = useRef<HTMLFormElement>(null)
  useModal(dialog, () => { onClose() })
  const [templates, setTemplates] = useState(false)

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-label="Réglages"
        onSubmit={(e) => { e.preventDefault(); if (trimmed !== '' && !busy) void save(trimmed) }}>
        <h2>Réglages</h2>
        <label>
          Clé API Anthropic
          <input autoFocus type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={status?.set ? '•••••••• (enregistrée)' : 'sk-ant-…'} spellCheck={false} disabled={!canStore} />
        </label>
        {/* A key that can no longer be read is not used: only the alert below speaks of it. */}
        {!(status?.set && !status.readable) && (
          <span data-testid="key-status" style={{ color: 'var(--fg-3)', fontSize: 12, lineHeight: 1.5 }}>
            {status?.set
              ? 'Une clé est enregistrée : les nouvelles sessions l’utilisent à la place de ton login Claude.'
              : 'Aucune clé : les sessions utilisent ton login Claude personnel.'}
          </span>
        )}
        {!canStore && (
          <p className="risk" role="alert">
            Le trousseau macOS n’est pas disponible : Canopy ne stocke jamais une clé en clair, elle ne peut pas être enregistrée.
          </p>
        )}
        {status?.set && !status.readable && (
          <p className="risk" role="alert">
            La clé API enregistrée n&apos;est plus lisible (l&apos;application a changé de signature). Saisis-la à nouveau.
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
        <LinearSettings />
        {repo && (
          <div className="tickets-settings" data-testid="tickets-settings">
            <span className="title">Tickets</span>
            <label>
              Préfixe des tickets
              <input value={prefix} spellCheck={false} aria-invalid={!prefixValid} data-testid="ticket-prefix"
                onChange={(e) => { setPrefix(e.target.value.toUpperCase()); setPrefixNotice(null) }}
                onBlur={() => void savePrefix()}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void savePrefix() } }} />
            </label>
            {!prefixValid && saved !== null && (
              <p className="error" role="alert">Lettres majuscules et chiffres, 10 au plus, commençant par une lettre</p>
            )}
            <span style={{ color: 'var(--fg-3)', fontSize: 12, lineHeight: 1.5 }}>S'applique aux nouveaux tickets.</span>
            {prefixNotice && <span role="status" style={{ color: 'var(--add)', fontSize: 12 }}>{prefixNotice}</span>}
            <button type="button" className="secondary" onClick={() => setTemplates(true)}>Modèles de tickets…</button>
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
      {/* Outside the form, whose submit its fields must not trigger; opened last, it is the modal Escape closes. */}
      {templates && repo && <TemplatesDialog repo={repo} onClose={() => setTemplates(false)} />}
    </div>
  )
}
