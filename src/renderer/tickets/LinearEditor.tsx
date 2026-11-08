import { useEffect, useId, useReducer, useRef, useState } from 'react'
import {
  LINEAR_MAX_TITLE, linearBranchName, readableDescription,
  type LinearComment, type LinearField, type LinearIssue, type LinearIssueDetail, type LinearStatus, type LinearUser, type PendingEdit
} from '../../shared/linear'
import { MAX_DESCRIPTION, PRIORITIES, PRIORITY_LABEL, type TicketPriority, ticketKey } from '../../shared/tickets'
import { basename, useApp } from '../store'
import { Markdown } from '../sessions/Markdown'
import {
  closeLinearSaver, commentDraft, conflictHint, createLinearSaver, setCommentDraft, linearSaverFor, notifyLinearSavers, trackLinearSaver, type SideChange, type TextKey
} from './linearSave'
import { createEditorReload } from './linearReload'
import { useLinear } from './linearStore'
import { Description } from './TicketEditor'

type Options = { statuses: LinearStatus[]; labels: string[]; users: LinearUser[] }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const LEAVING = 'Ce ticket quittera ta liste au prochain rafraîchissement.'
const FIELD_NAME: Partial<Record<LinearField, string>> = {
  title: 'Titre', statusId: 'Statut', priority: 'Priorité', labels: 'Étiquettes', assigneeId: 'Assigné'
}

/** A `save` answer has no parent, cycle nor project: those stay from the detail read. */
const mergeAnswer = (d: LinearIssueDetail, i: LinearIssue): LinearIssueDetail =>
  ({ ...d, ...i, parentId: d.parentId, cycle: d.cycle, project: d.project, children: d.children, comments: d.comments })

/** Screen 3b for a Linear issue: side fields go at once, title and description on blur and on close. */
export function LinearEditor({ id }: { id: string }): React.JSX.Element {
  return <Editor key={id} id={id} />
}

function Editor({ id }: { id: string }): React.JSX.Element {
  const ids = useId()
  // A closed editor of this issue may have left text it could not send: it comes back here.
  const [saver] = useState(() => linearSaverFor(id, () => createLinearSaver(id, { title: '', description: '' }, (c) => window.canopy.linearSave(id, c))))
  const [detail, setDetail] = useState<LinearIssueDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [options, setOptions] = useState<Options | null>(null)
  const [entry, setEntry] = useState<PendingEdit | undefined>(undefined)
  /** The last `pending` reason main gave, until a send goes through. */
  const [reason, setReason] = useState<string | null>(() => (saver.unsent() ? 'Le dernier envoi a échoué : ce texte n’est pas encore dans Linear.' : null))
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const live = useRef(true)
  const me = useLinear((s) => s.connection.userId)
  const link = useLinear((s) => s.links[id])
  /** `updatedAt` of the list's copy: newer than the one shown means Linear changed it. */
  const listedAt = useLinear((s) => s.list.issues.find((i) => i.id === id)?.updatedAt)
  const shownAt = useRef<string | null>(null)
  shownAt.current = detail?.updatedAt ?? null
  const gate = useRef<ReturnType<typeof createEditorReload> | null>(null)

  /** Reads the issue and main's queue; typed text stays, the rest follows Linear. */
  const load = async (): Promise<void> => {
    const readAt = saver.generation()
    try {
      const [d, pending] = await Promise.all([window.canopy.linearIssue(id), window.canopy.linearPending()])
      if (!live.current) return
      const p = pending.find((x) => x.id === id)
      if (saver.generation() !== readAt) {
        // A send or an answer came during the read: it may predate them, only the read-only parts are taken.
        const { children, comments, parentId, cycle, project } = d
        setDetail((cur) => (cur ? { ...cur, children, comments, parentId, cycle, project } : d))
      } else {
        if (saver.reset(d, p, readAt) === 'same') void window.canopy.linearDiscard(id, ['description']).catch(() => undefined)
        setDetail(d)
        setEntry(p)
      }
      setLoadError(null)
      rerender()
    } catch (e) {
      if (live.current) setLoadError(message(e))
    }
  }
  const refreshPending = async (): Promise<void> => {
    const readAt = saver.generation()
    const pending = await window.canopy.linearPending().catch(() => null)
    if (live.current && pending && saver.generation() === readAt) setEntry(pending.find((x) => x.id === id))
  }

  useEffect(() => {
    live.current = true
    trackLinearSaver(id, saver)
    const offResult = saver.onResult((r, fresh) => {
      if (!live.current) return
      // An older answer arriving after a newer one must not show over it.
      if (r.issue && fresh) { const i = r.issue; setDetail((d) => (d ? mergeAnswer(d, i) : d)) }
      setReason(r.kind === 'pending' ? r.reason : null)
      notifyLinearSavers()
      rerender()
      void refreshPending()
    })
    void load()
    // Made per effect run: a stopped gate never reads again (StrictMode runs this effect twice).
    const g = createEditorReload({ id, reload: () => { void load() }, pending: () => { void refreshPending() }, knownAt: () => shownAt.current })
    gate.current = g
    const off = window.canopy.on('linear:changed', (p) => g.event(p))
    return () => {
      live.current = false
      g.stop()
      if (gate.current === g) gate.current = null
      off()
      offResult()
      // Closing sends what was typed; text that cannot go stays counted and comes back with the next editor.
      void closeLinearSaver(id, saver, () => !live.current)
    }
  }, [])

  useEffect(() => { gate.current?.listed(listedAt) }, [listedAt, detail?.updatedAt])

  const teamId = detail?.team.id
  useEffect(() => {
    if (!teamId) return
    let on = true
    window.canopy.linearTeamOptions(teamId).then((o) => { if (on) setOptions(o) }, (e: unknown) => { if (on) setError(message(e)) })
    return () => { on = false }
  }, [teamId])

  const app = useApp.getState()
  const back = (): void => app.setOpenTicket(null)

  if (loadError && !detail) {
    return (
      <div className="ticket-editor">
        <div className="editor-main">
          <div className="editor-col">
            <Header id={id} onBack={back} />
            <p className="editor-missing" role="alert">Ce ticket Linear est introuvable ou illisible : {loadError}</p>
            <button className="secondary" onClick={() => void load()}>Réessayer</button>
          </div>
        </div>
      </div>
    )
  }
  if (!detail) return <div className="ticket-editor"><p className="editor-loading">Chargement…</p></div>

  const p = entry?.change
  const side = saver.side()
  const statusId = side.statusId ?? p?.statusId ?? detail.status.id ?? options?.statuses.find((s) => s.name === detail.status.name)?.id ?? ''
  const priority = side.priority ?? p?.priority ?? detail.priority
  const labels = side.labels?.next ?? p?.labels?.next ?? detail.labels
  const assigneeId = side.assigneeId !== undefined ? side.assigneeId : p?.assigneeId !== undefined ? p.assigneeId : detail.assignee?.id ?? null
  const users = options?.users ?? (detail.assignee ? [detail.assignee] : [])

  const change = (c: SideChange): void => {
    saver.field(c)
    rerender()
  }
  const assign = (next: string | null): void => {
    if (me && assigneeId === me && next !== me) setLeaving(true)
    change({ assigneeId: next })
  }
  const type = (k: TextKey, v: string): void => { saver.text(k, v); notifyLinearSavers(); rerender() }
  const commit = (k: TextKey): void => { void saver.commit(k).then(() => { notifyLinearSavers(); rerender() }) }
  const discard = async (fields: LinearField[]): Promise<void> => {
    try {
      await window.canopy.linearDiscard(id, fields)
      // Only these fields take Linear's value: text being typed elsewhere stays.
      saver.resetFields(await window.canopy.linearIssue(id), fields)
    } catch (e) { setError(message(e)); return }
    notifyLinearSavers()
    rerender()
    await load()
  }
  const keepMine = (): void => { void saver.keepMine().then(() => rerender()) }
  const takeTheirs = async (): Promise<void> => {
    try { await window.canopy.linearDiscard(id, ['description']) } catch (e) { setError(message(e)); return }
    saver.takeTheirs()
    notifyLinearSavers()
    await load()
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(detail.url).then(() => {
      setCopied(true)
      setTimeout(() => { if (live.current) setCopied(false) }, 1500)
    }, (e: unknown) => setError(message(e)))
  }
  const launch = (): void => {
    app.setSelectedTicket(ticketKey('linear', id))
    app.setOpenTicket(null)
    app.setView('tickets')
  }

  const conflict = saver.conflict()
  const unsentReason = reason ?? (entry ? entry.error || Object.values(entry.held)[0] || 'en attente d’envoi' : null)
  const held = (f: LinearField): React.ReactNode => {
    const why = entry?.held[f]
    if (!why) return null
    return (
      <p className="held-note" role="status">
        {FIELD_NAME[f] ?? f} non envoyé : {why}{' '}
        <button className="link" onClick={() => void discard([f])}>Retirer</button>
      </p>
    )
  }

  return (
    <div className="ticket-editor linear-editor">
      <div className="editor-main">
        <div className="editor-col">
          <div className="editor-top">
            <Header id={id} team={detail.team.name} onBack={back} />
            <button className="secondary editor-btn" onClick={() => void window.canopy.openExternal(detail.url).catch(() => undefined)}>
              Ouvrir dans Linear <span aria-hidden="true">↗</span>
            </button>
            <button className="secondary editor-btn" onClick={copy}>{copied ? 'Lien copié' : 'Copier le lien'}</button>
          </div>
          {unsentReason && (
            <p className="editor-unsent" role="status"><span className="pending-mark">non envoyé</span> {unsentReason}</p>
          )}
          {error && <p className="editor-error" role="alert">{error}</p>}
          {loadError && <p className="editor-error" role="alert">Relecture impossible : {loadError}</p>}

          <label className="editor-label" htmlFor={`${ids}-title`}>Titre</label>
          <input id={`${ids}-title`} className="editor-title" value={saver.value('title')} placeholder="Titre du ticket"
            spellCheck={false} maxLength={LINEAR_MAX_TITLE}
            onChange={(e) => type('title', e.target.value)} onBlur={() => commit('title')} />
          {held('title')}

          {conflict
            ? (
              <section className="linear-conflict" aria-label="Conflit sur la description">
                <p className="editor-hint">{conflictHint(entry)}</p>
                <div className="conflict-sides">
                  <div><h3>Version Linear</h3><pre>{conflict.remote}</pre></div>
                  <div><h3>Ta version</h3><pre>{conflict.mine}</pre></div>
                </div>
                <div className="conflict-actions">
                  <button className="primary editor-btn" onClick={keepMine}>Garder la mienne</button>
                  <button className="secondary editor-btn" onClick={() => void takeTheirs()}>Prendre celle de Linear</button>
                </div>
              </section>
            )
            : (
              <Description value={saver.value('description')}
                focus={{ onFocus: () => undefined, onBlur: () => commit('description') }}
                onChange={(v) => type('description', v)}
                preview={(text) => <Markdown text={readableDescription(text)} />} />
            )}

          <SubIssues items={detail.children} />
          <Comments id={id} items={detail.comments}
            onAdded={(c) => setDetail((d) => (d ? { ...d, comments: [...d.comments, c] } : d))} />
        </div>
      </div>

      <aside className="editor-side" aria-label="Propriétés">
        <label className="prop">
          <span>Statut</span>
          <select value={statusId} onChange={(e) => change({ statusId: e.target.value })}>
            {!options?.statuses.some((s) => s.id === statusId) && <option value={statusId}>{detail.status.name}</option>}
            {options?.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {held('statusId')}
        <label className="prop">
          <span>Priorité</span>
          <select value={priority} onChange={(e) => change({ priority: e.target.value as TicketPriority })}>
            {PRIORITIES.map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}
          </select>
        </label>
        {held('priority')}
        <LabelPicker value={labels} known={options?.labels ?? []} onChange={(l) => change({ labels: { base: labels, next: l } })} />
        {held('labels')}
        <label className="prop">
          <span>Assigné</span>
          <select value={assigneeId ?? ''} onChange={(e) => assign(e.target.value === '' ? null : e.target.value)}>
            <option value="">Personne</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        {held('assigneeId')}
        {leaving && <p className="editor-hint" role="status">{LEAVING}</p>}
        <div className="prop readonly"><span>Équipe</span><span>{detail.team.name}</span></div>
        <div className="prop readonly"><span>Cycle</span><span>{detail.cycle ?? '—'}</span></div>
        <div className="prop readonly"><span>Projet</span><span>{detail.project ?? '—'}</span></div>

        <section className="dev" aria-labelledby={`${ids}-dev`}>
          <h3 id={`${ids}-dev`}>Lancement</h3>
          {link
            ? (
              <button className="dev-link" title={`Ouvrir ${link.worktree} dans Sessions`}
                onClick={() => { app.setWorktree(link.worktree); app.setView('sessions') }}>
                <span className="mono dev-branch">{link.branch}</span>
                <span className="dev-worktree">Worktree {basename(link.worktree)} · ouvrir dans Sessions</span>
              </button>
            )
            : (
              <>
                <p className="mono dev-branch" title="Branche proposée">{linearBranchName({ id, title: saver.value('title') || detail.title })}</p>
                <button className="primary dev-launch" onClick={launch}><span aria-hidden="true">▶</span> Lancer {id}</button>
              </>
            )}
        </section>
      </aside>
    </div>
  )
}

function Header(props: { id: string; team?: string; onBack: () => void }): React.JSX.Element {
  return (
    <>
      <button className="secondary editor-btn editor-back" onClick={props.onBack} title="Revenir à la liste des tickets">
        <span aria-hidden="true">←</span> Retour
      </button>
      <nav className="breadcrumb" aria-label="Fil d'Ariane">
        <span className="source-badge" data-source="linear">Linear</span>
        <span className="mono" aria-current="page">{props.id}</span>
        {props.team && <span>· équipe {props.team}</span>}
      </nav>
    </>
  )
}

function SubIssues(props: { items: LinearIssueDetail['children'] }): React.JSX.Element | null {
  if (props.items.length === 0) return null
  const done = props.items.filter((c) => c.status.type === 'completed').length
  return (
    <section className="subtasks" aria-label="Sous-tickets">
      <div className="subtasks-head"><h3>Sous-tickets <span className="n">{done} / {props.items.length}</span></h3></div>
      {props.items.map((c) => (
        <button key={c.id} className="sub-issue" onClick={() => useApp.getState().setOpenTicket(ticketKey('linear', c.id))}>
          <span className="mono">{c.id}</span> <span className="sub-issue-title">{c.title}</span> <span className="status-name">{c.status.name}</span>
        </button>
      ))}
    </section>
  )
}

function Comments(props: { id: string; items: LinearComment[]; onAdded: (c: LinearComment) => void }): React.JSX.Element {
  const ids = useId()
  // A comment typed in an earlier editor of this issue comes back; it counts as unsaved until posted.
  const [body, setBodyState] = useState(() => commentDraft(props.id))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const empty = body.trim() === ''
  const setBody = (v: string): void => { setBodyState(v); setCommentDraft(props.id, v) }
  const send = async (): Promise<void> => {
    if (empty || sending) return
    setSending(true)
    setError(null)
    const sent = body
    try {
      props.onAdded(await window.canopy.linearComment(props.id, sent))
      // Only what was posted is cleared: text typed during the send stays.
      if (commentDraft(props.id) === sent) setBody('')
    } catch (e) {
      setError(message(e))
    } finally {
      setSending(false)
    }
  }
  return (
    <section className="comments" aria-labelledby={`${ids}-c`}>
      <h3 id={`${ids}-c`}>Commentaires <span className="n">{props.items.length}</span></h3>
      {props.items.map((c) => (
        <article key={c.id} className="comment">
          <header>{c.author} · {new Date(c.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</header>
          <Markdown text={readableDescription(c.body)} />
        </article>
      ))}
      <textarea className="comment-input" value={body} placeholder="Ajouter un commentaire…" aria-label="Ajouter un commentaire"
        maxLength={MAX_DESCRIPTION} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }} />
      {error && <p className="editor-error" role="alert">Commentaire non envoyé : {error}</p>}
      <button className="secondary editor-btn comment-send" disabled={empty || sending} onClick={() => void send()}>
        Commenter <kbd>⌘↵</kbd>
      </button>
    </section>
  )
}

function LabelPicker(props: { value: string[]; known: string[]; onChange: (l: string[]) => void }): React.JSX.Element {
  const rest = props.known.filter((k) => !props.value.includes(k))
  return (
    <div className="prop labels">
      <span>Étiquettes</span>
      <div className="chips">
        {props.value.map((l) => (
          <span key={l} className="chip">
            {l}
            <button aria-label={`Retirer ${l}`} title="Retirer" onClick={() => props.onChange(props.value.filter((x) => x !== l))}>×</button>
          </span>
        ))}
        {rest.length > 0 && (
          <select className="label-pick" aria-label="Ajouter une étiquette" value=""
            onChange={(e) => { if (e.target.value) props.onChange([...props.value, e.target.value]) }}>
            <option value="">+</option>
            {rest.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}
