import { useEffect, useRef, useState } from 'react'
import { MAX_DESCRIPTION, MAX_TITLE, ticketKey, type TicketTemplate } from '../../shared/tickets'
import { useModal } from '../shell/useModal'
import { useApp } from '../store'
import { quickTicketFields } from './editorSave'

const NOTICE_MS = 6000

/** ⇧⌘T: a local ticket written down without leaving the screen. */
export function QuickTicketDialog({ repo, onCreated }: { repo: string; onCreated: (id: string) => void }): React.JSX.Element {
  const setDialog = useApp((s) => s.setDialog)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [template, setTemplate] = useState<TicketTemplate | null>(null)
  // The default template, like in the ticket draft; a description already typed stays.
  useEffect(() => {
    let on = true
    window.canopy.ticketTemplates(repo).then((list) => {
      const t = list.entries.flatMap((e) => (e.kind === 'template' && e.template.slug === list.defaultSlug ? [e.template] : []))[0] ?? null
      if (!on || !t) return
      setTemplate(t)
      setDescription((d) => (d === '' ? t.description : d))
    }, () => {})
    return () => { on = false }
  }, [repo])
  const fields = quickTicketFields(title, description, template)
  const close = (): void => { if (!busy) setDialog(null) }

  const submit = async (e?: React.FormEvent): Promise<void> => {
    e?.preventDefault()
    if (!fields || busy) return
    setBusy(true)
    setError(null)
    try {
      const t = await window.canopy.createTicket(repo, fields)
      setDialog(null)
      onCreated(t.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void submit() }
  }

  const dialog = useRef<HTMLFormElement>(null)
  useModal(dialog, close)

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <form ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-label="Nouveau ticket" onSubmit={(e) => void submit(e)}>
        <h2>Nouveau ticket</h2>
        <label>
          Titre
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onKeyDown} spellCheck={false} maxLength={MAX_TITLE} />
        </label>
        <label>
          Description
          <textarea className="quick-ticket-description" rows={5} maxLength={MAX_DESCRIPTION} value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={close} disabled={busy}>Annuler</button>
          <button type="submit" className="primary" disabled={!fields || busy}>{busy ? 'Création…' : 'Créer'}</button>
        </div>
      </form>
    </div>
  )
}

/** Says the ticket was made, with a way to it; the screen the user was on stays. */
export function QuickTicketNotice({ id, onDone }: { id: string; onDone: () => void }): React.JSX.Element {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => done.current(), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [id])
  const open = (): void => {
    const app = useApp.getState()
    app.setView('tickets')
    // The editor saves as it is typed in and writes the rest when it closes: swapping it loses nothing.
    app.setOpenTicket(ticketKey('local', id))
    onDone()
  }
  return (
    <div className="quick-ticket-notice" role="status" data-testid="quick-ticket-notice">
      <span>Ticket {id} créé</span>
      <button onClick={open}>Ouvrir</button>
    </div>
  )
}
