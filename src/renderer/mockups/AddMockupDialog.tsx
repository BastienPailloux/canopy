import { useRef, useState } from 'react'
import { MAX_MOCKUP_TITLE, parseArtifactUrl, type Mockup, type MockupKind } from '../../shared/mockups'
import { useModal } from '../shell/useModal'
import { useTickets } from '../tickets/ticketStore'
import { KIND_LABEL, upsertMockup } from './mockupStore'

/**
 * « + Ajouter un lien »: a claude.ai mockup link, an optional title, its template and ticket. From a ticket, a mockup
 * already linked to another live ticket is shown as such, with a button to move it; one whose ticket is archived or
 * gone is linked right away (a dead ticket is no ticket).
 */
export function AddMockupDialog(props: {
  repo: string
  /** Ticket preset in the form (from a ticket's « Coller un lien claude.ai… »). */
  ticket?: string
  onAdded?: (m: Mockup) => void
  onClose: () => void
}): React.JSX.Element {
  const entries = useTickets((s) => s.entries)
  const tickets = entries.flatMap((e) => (e.kind === 'ticket' && !e.ticket.archived ? [e.ticket] : []))
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<MockupKind>('web')
  const [ticket, setTicket] = useState(props.ticket ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The mockup pasted from a ticket, already linked to another live ticket. */
  const [conflict, setConflict] = useState<Mockup | null>(null)

  const parsed = parseArtifactUrl(url)
  const wrongLink = url.trim() !== '' && !parsed

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!parsed || busy) return
    setBusy(true)
    setError(null)
    try {
      const t = title.trim()
      const m = await window.canopy.addMockup(props.repo, parsed.url, {
        kind, ...(t !== '' ? { title: t } : {}), ...(ticket !== '' ? { ticket } : {})
      })
      upsertMockup(props.repo, m)
      if (props.ticket !== undefined && ticket !== '' && m.ticket !== undefined && m.ticket !== ticket) {
        if (tickets.some((x) => x.id === m.ticket)) {
          setConflict(m)
          setBusy(false)
          return
        }
        return await relink(m)
      }
      props.onAdded?.(m)
      props.onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  /** Links `m` to the form's ticket, then closes. */
  const relink = async (m: Mockup): Promise<void> => {
    const r = await window.canopy.patchMockup(props.repo, m.id, { ticket })
    upsertMockup(props.repo, r)
    props.onAdded?.(r)
    props.onClose()
  }

  const moveConflict = async (): Promise<void> => {
    if (!conflict || busy) return
    setBusy(true)
    setError(null)
    try {
      await relink(conflict)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const dialog = useRef<HTMLFormElement>(null)
  useModal(dialog, () => { if (!busy) props.onClose() })

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) props.onClose() }}>
      <form ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-label="Ajouter une maquette" onSubmit={(e) => void submit(e)}>
        <h2>Ajouter une maquette</h2>
        <label>
          Lien claude.ai
          <input autoFocus value={url} onChange={(e) => { setUrl(e.target.value); setConflict(null) }} placeholder="https://claude.ai/artifact/…" spellCheck={false}
            aria-invalid={wrongLink || undefined} />
        </label>
        {wrongLink && <p className="error" role="alert">Ce lien n’est pas une maquette claude.ai.</p>}
        <label>
          Titre (facultatif)
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_MOCKUP_TITLE}
            placeholder="Repris de la page s’il est vide" />
        </label>
        <label>
          Gabarit
          <select aria-label="Gabarit" value={kind} onChange={(e) => setKind(e.target.value as MockupKind)}>
            <option value="web">{KIND_LABEL.web}</option>
            <option value="phone">{KIND_LABEL.phone}</option>
          </select>
        </label>
        <label>
          Ticket
          <select aria-label="Ticket" value={ticket} onChange={(e) => { setTicket(e.target.value); setConflict(null) }}>
            <option value="">Aucun</option>
            {props.ticket && !tickets.some((t) => t.id === props.ticket) && <option value={props.ticket}>{props.ticket}</option>}
            {tickets.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
          </select>
        </label>
        {conflict && (
          <p className="error" role="alert">
            Déjà liée à {conflict.ticket}{' '}
            <button type="button" className="secondary" onClick={() => void moveConflict()} disabled={busy}>Lier à {ticket}</button>
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={props.onClose} disabled={busy}>Annuler</button>
          <button type="submit" className="primary" disabled={!parsed || busy || conflict !== null}>{busy ? 'Ajout…' : 'Ajouter'}</button>
        </div>
      </form>
    </div>
  )
}
