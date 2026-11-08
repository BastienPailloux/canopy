import { useEffect, useId, useRef, useState } from 'react'
import {
  MAX_MOCKUP_TITLE, MOCKUP_STATUS_LABEL, MOCKUP_STATUSES, mockupLine, shownStatus,
  type Mockup, type MockupChanges, type MockupKind, type MockupStatus, type MockupTitleEvent
} from '../../shared/mockups'
import type { Ticket } from '../../shared/tickets'
import { Conversation } from '../sessions/Conversation'
import { useSessions } from '../sessions/sessionStore'
import { useApp } from '../store'
import { chatTab, sendEdit, usePublishError } from './mockupChat'
import { StatusPill } from './MockupCard'
import { MockupWebView } from './MockupWebView'
import {
  attachToSession, dropMockup, KIND_LABEL, linkedTicket, ticketWorktree, upsertMockup, useMockups, useTicketList
} from './mockupStore'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Screen 4b: one mockup (`'new'`: one Claude is to create), its claude.ai view, its conversation and properties. */
export function MockupEditor({ id }: { id: string }): React.JSX.Element | null {
  const repo = useApp((s) => s.repo)
  const cwd = useApp((s) => s.worktrees.find((w) => w.isMain)?.path ?? null)
  const loaded = useMockups((s) => s.loaded)
  const mockup = useMockups((s) => (id === 'new' ? null : s.list.find((m) => m.id === id) ?? null))
  const back = (): void => useApp.getState().setOpenMockup(null)
  if (!repo) return null
  if (id !== 'new' && !mockup) {
    return (
      <div className="mockup-editor-missing">
        <p role={loaded ? 'alert' : undefined}>{loaded ? 'Cette maquette n’est plus dans Canopy.' : 'Chargement…'}</p>
        {loaded && <button className="secondary" onClick={back}>← Toutes les maquettes</button>}
      </div>
    )
  }
  return <Editor key={`${repo}\0${cwd}\0${id}`} repo={repo} cwd={cwd} mockup={mockup} onBack={back} />
}

function Editor(props: { repo: string; cwd: string | null; mockup: Mockup | null; onBack: () => void }): React.JSX.Element {
  const { repo, cwd, mockup: m } = props
  const tickets = useTicketList()
  const ticket = m ? linkedTicket(m, tickets) : undefined
  const branchWorktree = useApp((s) => ticketWorktree(ticket, s.worktrees))
  const [panel, setPanel] = useState<'claude' | 'props'>('claude')
  const [tabId, setTabId] = useState(() => (cwd ? chatTab(cwd, m?.id ?? 'new') : undefined))
  const error = usePublishError((s) => s.text)

  // What the title handler must read: the mockup as it is now, not as when it was set up.
  const current = useRef(m)
  current.current = m

  // The page title names the mockup until the user gives it a name.
  useEffect(() => window.canopy.on('mockups:title', (p) => {
    const { url, title } = p as MockupTitleEvent
    const cur = current.current
    const next = title.slice(0, MAX_MOCKUP_TITLE).trim()
    if (!cur || cur.titleSet || url !== cur.url || next === '' || next === cur.title) return
    window.canopy.patchMockup(repo, cur.id, { title: next, titleSet: false }).then((r) => upsertMockup(repo, r), () => undefined)
  }), [repo])

  const status = m ? shownStatus(m, ticket) : null

  return (
    <div className="mockup-editor">
      <nav className="mockup-editor-rail" aria-label="Maquettes">
        <button className="link" onClick={props.onBack}>← Toutes les maquettes</button>
      </nav>
      <main className="mockup-editor-main">
        <div className="mockup-editor-head">
          <h1>{m?.title ?? 'Nouvelle maquette'}</h1>
          {status && <StatusPill status={status} />}
          <div className="mockup-editor-tools">
            <button className="secondary" disabled={!m} onClick={() => void window.canopy.reloadMockupView().catch(() => undefined)}>Recharger</button>
            <button className="secondary" disabled={!m} onClick={() => { if (m) void window.canopy.openExternal(m.url).catch(() => undefined) }}>
              Ouvrir dans claude.ai
            </button>
          </div>
        </div>
        {error && (
          <p className="mockups-error" role="alert">
            {error} <button className="link" onClick={() => usePublishError.setState({ text: null })}>Fermer</button>
          </p>
        )}
        <MockupWebView url={m?.url ?? null}>
          <div className="mockup-view-invite">
            <h2>Nouvelle maquette</h2>
            <p>Décris à Claude la maquette à créer : il la publie sur claude.ai, et elle s’affiche ici.</p>
          </div>
        </MockupWebView>
      </main>
      <aside className="mockup-editor-side" aria-label="Modifier avec Claude">
        <div className="mockup-side-tabs" role="tablist" aria-label="Panneau">
          <button role="tab" aria-selected={panel === 'claude'} onClick={() => setPanel('claude')}>Claude</button>
          <button role="tab" aria-selected={panel === 'props'} onClick={() => setPanel('props')}>Propriétés</button>
        </div>
        {panel === 'claude'
          ? <Chat repo={repo} cwd={cwd} mockup={m} tabId={tabId} onTab={setTabId} />
          : m
            ? <Properties repo={repo} mockup={m} ticket={ticket} tickets={tickets} onRemoved={props.onBack} />
            : <p className="mockup-side-note">La maquette sera enregistrée dans Canopy dès que Claude l’aura publiée.</p>}
        {m && branchWorktree && (
          <div className="mockup-side-foot">
            <button className="send-session" onClick={() => attachToSession(branchWorktree.path, mockupLine(m))}>
              Envoyer à la session <span className="mono">{ticket?.branch}</span>
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}

/** The conversation of the mockup's tab, and its own small composer. */
function Chat(props: { repo: string; cwd: string | null; mockup: Mockup | null; tabId: string | undefined; onTab: (id: string) => void }): React.JSX.Element {
  const { cwd, mockup } = props
  const ids = useId()
  const tab = useSessions((s) => (props.tabId ? s.tabs[props.tabId] : undefined))
  const [text, setText] = useState('')
  const [variant, setVariant] = useState(false)
  const [sending, setSending] = useState(false)

  const apply = async (): Promise<void> => {
    const t = text.trim()
    if (!cwd || t === '' || sending) return
    setSending(true)
    setText('')
    try {
      const r = await sendEdit(props.repo, cwd, mockup, t, variant && !!mockup, props.onTab)
      if (r.sent) setVariant(false)
      else setText((now) => (now === '' ? t : now))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mockup-chat">
      {tab
        ? <Conversation key={tab.id} tab={tab} />
        : (
          <p className="mockup-side-note">
            {mockup
              ? 'Claude lit la maquette, la modifie selon ta demande et la republie : la vue se recharge.'
              : 'Claude crée la maquette avec l’outil Artifact et la publie sur claude.ai.'}
          </p>
        )}
      {tab?.state === 'running' && <p className="mockup-chat-state">Claude travaille…</p>}
      {tab?.error && <p className="mockups-error" role="alert">{tab.error}</p>}
      {!cwd && <p className="mockups-error" role="alert">Checkout principal introuvable : la conversation ne peut pas démarrer.</p>}
      <form className="mockup-composer" onSubmit={(e) => { e.preventDefault(); void apply() }}>
        <label htmlFor={`${ids}-edit`}>Décris la modification</label>
        <textarea id={`${ids}-edit`} rows={3} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={mockup ? 'Ex. : passe le bouton en pleine largeur, ajoute un état de chargement…' : 'Ex. : un écran de connexion mobile, avec mot de passe oublié…'}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void apply() } }} />
        <div className="mockup-composer-row">
          {mockup && (
            <label className="check">
              <input type="checkbox" checked={variant} onChange={(e) => setVariant(e.target.checked)} />
              Créer une variante
            </label>
          )}
          <button type="submit" className="primary" disabled={!cwd || text.trim() === '' || sending}>Appliquer ⌘↵</button>
        </div>
      </form>
    </div>
  )
}

function Properties(props: { repo: string; mockup: Mockup; ticket: Ticket | undefined; tickets: Ticket[]; onRemoved: () => void }): React.JSX.Element {
  const { repo, mockup: m, ticket } = props
  const ids = useId()
  const [name, setName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const live = props.tickets.filter((t) => !t.archived)

  const patch = (c: MockupChanges): void => {
    setError(null)
    window.canopy.patchMockup(repo, m.id, c).then((r) => upsertMockup(repo, r), (e: unknown) => setError(message(e)))
  }
  const commitName = (): void => {
    const t = name?.trim() ?? ''
    setName(null)
    if (t !== '' && t !== m.title) patch({ title: t })
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.canopy.removeMockup(repo, m.id)
      dropMockup(repo, m.id)
      useApp.getState().setSelectedMockup(null)
      props.onRemoved()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  return (
    <div className="mockup-properties">
      <div className="prop-field">
        <label htmlFor={`${ids}-name`}>Nom</label>
        <input id={`${ids}-name`} value={name ?? m.title} maxLength={MAX_MOCKUP_TITLE} onChange={(e) => setName(e.target.value)}
          onBlur={commitName} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setName(null) }} />
      </div>
      <div className="prop-field">
        <label htmlFor={`${ids}-ticket`}>Ticket lié</label>
        <select id={`${ids}-ticket`} value={m.ticket ?? ''} onChange={(e) => patch({ ticket: e.target.value === '' ? null : e.target.value })}>
          <option value="">Aucun</option>
          {m.ticket && !ticket && <option value={m.ticket}>{m.ticket} (archivé ou introuvable)</option>}
          {live.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
        </select>
      </div>
      <div className="prop-field">
        <label htmlFor={`${ids}-status`}>Statut</label>
        <select id={`${ids}-status`} value={shownStatus(m, ticket)} disabled={!!ticket} title={ticket ? 'Déduit du statut du ticket lié' : undefined}
          onChange={(e) => patch({ status: e.target.value as MockupStatus })}>
          {MOCKUP_STATUSES.map((s) => <option key={s} value={s}>{MOCKUP_STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      <div className="prop-field">
        <span>Branche</span>
        <span className="mono">{ticket?.branch ?? '—'}</span>
      </div>
      <div className="prop-field">
        <label htmlFor={`${ids}-kind`}>Gabarit</label>
        <select id={`${ids}-kind`} value={m.kind} onChange={(e) => patch({ kind: e.target.value as MockupKind })}>
          <option value="web">{KIND_LABEL.web}</option>
          <option value="phone">{KIND_LABEL.phone}</option>
        </select>
      </div>
      {error && <p className="mockups-error" role="alert">{error}</p>}
      {confirming
        ? (
          <div className="mockup-remove-confirm" role="group" aria-label="Confirmer le retrait">
            <span>La maquette reste sur claude.ai ; Canopy l’oublie.</span>
            <div>
              <button className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Annuler</button>
              <button className="danger" disabled={busy} onClick={() => void remove()}>Retirer</button>
            </div>
          </div>
        )
        : <button className="mockup-remove" onClick={() => setConfirming(true)}>Retirer de Canopy</button>}
    </div>
  )
}
