import { useEffect, useId, useRef, useState } from 'react'
import {
  MAX_DESCRIPTION, MAX_LABEL, MAX_LABELS, MAX_SUBTASKS, MAX_TITLE, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, STATUSES,
  type Subtask, type Ticket, type TicketFields, type TicketPatch, type TicketPriority, type TicketStatus,
  ticketKey,
} from '../../shared/tickets'
import { basename, useApp } from '../store'
import { applyFormat, type Format } from './descriptionTools'
import { closeSaver, createSaver, createVersionFilter, draftToCreate, mergeDisk, notifySavers, trackSaver, type Saver } from './editorSave'
import { LinkedMockups } from './LinkedMockups'
import { useTickets } from './ticketStore'
import { linkedWorktree, useRepoRefs } from './TicketsScreen'


const DRAFT: Ticket = {
  id: '', title: '', description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [], created: '', updated: '', archived: false
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Screen 3b: one ticket, saved as it is edited. `id` `'new'` is a draft: nothing is written before it has a title, then
 * the same editor goes on under the id it got.
 */
export function TicketEditor({ id }: { id: string }): React.JSX.Element | null {
  const repo = useApp((s) => s.repo)
  const adopted = useRef<string | null>(null)
  const key = useRef({ id, n: 0 })
  if (key.current.id !== id) key.current = { id, n: id === adopted.current ? key.current.n : key.current.n + 1 }
  if (!repo) return null
  return <Editor key={`${repo}\0${key.current.n}`} repo={repo} id={id} onCreated={(created) => { adopted.current = created }} />
}

function Editor(props: { repo: string; id: string; onCreated: (id: string) => void }): React.JSX.Element {
  const { repo } = props
  const ids = useId()
  const [ticket, setTicket] = useState<Ticket | null>(props.id === 'new' ? DRAFT : null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const entries = useTickets((s) => s.entries)
  const refs = useRepoRefs(repo, entries)

  /** What the editor shows, ahead of React state for the saver and the merges. */
  const local = useRef<Ticket | null>(ticket)
  /** The last title not empty: an emptied title goes back to it when the field is left. */
  const lastTitle = useRef('')
  /** The ticket's id, null while a draft has none. */
  const idRef = useRef<string | null>(props.id === 'new' ? null : props.id)
  /** The field the user is in: an incoming version leaves it alone. */
  const focused = useRef<keyof TicketFields | null>(null)
  const live = useRef(true)
  /** The last version read from disk: a field left without change takes its value back. */
  const lastDisk = useRef<Ticket | null>(null)
  const [fresh] = useState(createVersionFilter)
  const show = (t: Ticket): void => {
    local.current = t
    if (t.title.trim() !== '') lastTitle.current = t.title
    setTicket(t)
  }

  /** Takes a version of `t` from disk not seen yet; pending and focused fields keep the user's value. */
  const applyDisk = (t: Ticket): void => {
    if (!fresh(t)) return
    lastDisk.current = t
    const cur = local.current
    if (!cur) { show(t); return }
    const keep = saver.current.pending()
    if (focused.current) keep.add(focused.current)
    show(mergeDisk(cur, t, keep))
  }

  const save = async (changes: TicketPatch): Promise<void> => {
    let t: Ticket
    if (idRef.current) t = await window.canopy.patchTicket(repo, idRef.current, changes)
    else {
      // What shows now, not what was typed then: a title typed and erased since creates nothing.
      const all = draftToCreate(local.current ?? DRAFT)
      if (!all) return
      t = await window.canopy.createTicket(repo, all)
      idRef.current = t.id
      props.onCreated(t.id)
      if (live.current) useApp.getState().setOpenTicket(ticketKey('local', t.id))
    }
    if (!live.current) return
    setSaveError(null)
    applyDisk(t)
  }
  const saver = useRef<Saver>(null as unknown as Saver)
  saver.current ??= createSaver((c) => save(c), 500, {
    onError: (e) => { if (live.current) setSaveError(message(e)) },
    onPending: notifySavers
  })

  // Counted by what quitting would lose while it holds changes; once closed, it writes them, then stops being counted.
  useEffect(() => {
    live.current = true
    const s = saver.current
    trackSaver(s)
    return () => {
      live.current = false
      void closeSaver(s, () => !live.current)
    }
  }, [])

  useEffect(() => {
    if (props.id === 'new') return
    let on = true
    window.canopy.getTicket(repo, props.id).then(
      (t) => { if (on) applyDisk(t) },
      (e: unknown) => { if (on) setLoadError(message(e)) }
    )
    return () => { on = false }
  }, [])

  // A newer version on disk, from the list's reload on `tickets:changed`.
  useEffect(() => {
    const id = idRef.current
    const e = id ? entries.find((x) => x.kind === 'ticket' && x.ticket.id === id) : undefined
    if (e?.kind === 'ticket' && local.current) applyDisk(e.ticket)
  }, [entries])

  const [labels, setLabels] = useState<string[]>([])
  useEffect(() => {
    let on = true
    window.canopy.ticketLabels(repo).then((l) => { if (on) setLabels(l) }, () => {})
    return () => { on = false }
  }, [repo, entries])

  const app = useApp.getState()
  const back = (): void => app.setOpenTicket(null)

  if (loadError) {
    return (
      <div className="ticket-editor">
        <div className="editor-main">
          <div className="editor-col">
            <Breadcrumb id={props.id} onBack={back} />
            <p className="editor-missing" role="alert">Ce ticket est introuvable ou illisible : {loadError}</p>
            <button className="secondary" onClick={back}>Retour aux tickets</button>
          </div>
        </div>
      </div>
    )
  }
  if (!ticket) return <div className="ticket-editor"><p className="editor-loading">Chargement…</p></div>

  const id = idRef.current
  const update = (c: TicketPatch): void => {
    const { parent, ...shown } = c
    const next: Ticket = { ...(local.current ?? DRAFT), ...shown }
    if ('parent' in c) { if (parent) next.parent = parent; else delete next.parent }
    show(next)
    const { title, ...rest } = c
    const send: TicketPatch = title !== undefined && title.trim() !== '' ? c : rest
    // A draft is written once it has a title.
    if (!idRef.current && next.title.trim() === '') return
    if (!idRef.current && title === undefined) { saver.current.change({ title: next.title, ...send }); return }
    if (Object.keys(send).length > 0) saver.current.change(send)
  }
  /** Leaving field `k`: a version that came while the user was in it, and not overridden by them, now shows. */
  const leave = (k: keyof TicketFields): void => {
    if (focused.current === k) focused.current = null
    const cur = local.current
    const d = lastDisk.current
    if (cur && d && !saver.current.pending().has(k) && cur[k] !== d[k]) show({ ...cur, [k]: d[k] })
  }
  const focus = (k: keyof TicketFields) => ({
    onFocus: () => { focused.current = k },
    onBlur: () => leave(k)
  })

  const act = async (fn: (id: string) => Promise<void>): Promise<void> => {
    if (!id || busy) return
    setBusy(true)
    setActionError(null)
    try {
      if (!(await saver.current.flush())) throw new Error('Les dernières modifications ne sont pas enregistrées : action annulée.')
      await fn(id)
    } catch (e) {
      if (live.current) { setActionError(message(e)); setBusy(false) }
    }
  }
  const duplicate = (): Promise<void> => act(async (from) => {
    const copy = await window.canopy.duplicateTicket(repo, from)
    useApp.getState().setOpenTicket(ticketKey('local', copy.id))
  })
  const archive = (): Promise<void> => act(async (from) => {
    await window.canopy.archiveTicket(repo, from)
    useApp.getState().setSelectedTicket(null)
    useApp.getState().setOpenTicket(null)
  })
  const launch = (): void => {
    if (!id) return
    app.setSelectedTicket(ticketKey('local', id))
    app.setOpenTicket(null)
    app.setView('tickets')
  }

  const linked = id ? linkedWorktree(ticket, refs) : null
  const titleEmpty = ticket.title.trim() === ''

  return (
    <div className="ticket-editor">
      <div className="editor-main">
        <div className="editor-col">
          <div className="editor-top">
            <Breadcrumb id={id} onBack={back} />
            <button className="secondary editor-btn" disabled={!id || busy} onClick={() => void duplicate()}>Dupliquer</button>
          </div>
          {saveError && <p className="editor-error" role="alert">Enregistrement impossible : {saveError}</p>}
          {actionError && <p className="editor-error" role="alert">{actionError}</p>}

          <label className="editor-label" htmlFor={`${ids}-title`}>Titre</label>
          <input id={`${ids}-title`} className="editor-title" value={ticket.title} placeholder="Titre du ticket"
            autoFocus={!id} spellCheck={false} maxLength={MAX_TITLE} aria-invalid={(titleEmpty && !!id) || undefined}
            {...focus('title')}
            onChange={(e) => update({ title: e.target.value })}
            onBlur={() => {
              leave('title')
              const cur = local.current
              if (cur && cur.title.trim() === '' && lastTitle.current !== '') show({ ...cur, title: lastTitle.current })
            }} />
          {titleEmpty && <p className="editor-hint">{id ? 'Un ticket garde un titre : l’ancien revient en quittant le champ.' : 'Le ticket est créé dès qu’il a un titre.'}</p>}

          {ticket.parent && <ParentLine id={ticket.parent} entries={entries} />}

          <Description value={ticket.description} focus={focus('description')} onChange={(description) => update({ description })} />

          <Subtasks items={ticket.subtasks} focus={focus('subtasks')} onChange={(subtasks) => update({ subtasks })} />

          {id && <SubTickets parent={id} entries={entries} />}

          {id && <LinkedMockups repo={repo} ticket={id} />}
        </div>
      </div>

      <aside className="editor-side" aria-label="Propriétés">
        <label className="prop">
          <span>Statut</span>
          <select value={ticket.status} onChange={(e) => update({ status: e.target.value as TicketStatus })}>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="prop">
          <span>Priorité</span>
          <select value={ticket.priority} onChange={(e) => update({ priority: e.target.value as TicketPriority })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </label>
        <ParentSelect self={id} value={ticket.parent} entries={entries} onChange={(p) => update({ parent: p })} />
        <Labels value={ticket.labels} known={labels} focus={focus('labels')} onChange={(l) => update({ labels: l })} />

        <section className="dev" aria-labelledby={`${ids}-dev`}>
          <h3 id={`${ids}-dev`}>Développement</h3>
          {linked
            ? (
              <button className="dev-link" title={`Ouvrir ${linked.path} dans Sessions`}
                onClick={() => { app.setWorktree(linked.path); app.setView('sessions') }}>
                <span className="mono dev-branch">{ticket.branch}</span>
                <span className="dev-worktree">Worktree {basename(linked.path)} · ouvrir dans Sessions</span>
              </button>
            )
            : (
              <>
                <p>Aucun worktree pour l'instant.</p>
                <button className="primary dev-launch" disabled={!id} onClick={launch}>
                  <span aria-hidden="true">▶</span> Lancer {id ?? ''}
                </button>
              </>
            )}
        </section>

        <button className="archive" disabled={!id || busy} onClick={() => void archive()}>Archiver le ticket</button>
      </aside>
    </div>
  )
}

type Entries = ReturnType<typeof useTickets.getState>['entries']

const liveTickets = (entries: Entries): Ticket[] => entries.flatMap((e) => (e.kind === 'ticket' ? [e.ticket] : []))
const idNumber = (id: string): number => Number(id.slice(id.lastIndexOf('-') + 1))

/** « Sous-ticket de X · titre », a link to the parent, or its bare id when the list does not have it. */
function ParentLine(props: { id: string; entries: Entries }): React.JSX.Element {
  const p = liveTickets(props.entries).find((t) => t.id === props.id)
  if (!p) return <p className="parent-line">{props.id} (introuvable)</p>
  return (
    <button className="parent-line" onClick={() => useApp.getState().setOpenTicket(ticketKey('local', p.id))}>
      Sous-ticket de {p.id} · {p.title}
    </button>
  )
}

/** The tickets whose parent is `parent`, in the list's order of numbers; empty when it has none. */
function SubTickets(props: { parent: string; entries: Entries }): React.JSX.Element | null {
  const items = liveTickets(props.entries).filter((t) => t.parent === props.parent).sort((a, b) => idNumber(a.id) - idNumber(b.id))
  if (items.length === 0) return null
  const done = items.filter((c) => c.status === 'done').length
  return (
    <section className="subtasks" aria-label="Sous-tickets">
      <div className="subtasks-head"><h3>Sous-tickets <span className="n">{done} / {items.length}</span></h3></div>
      {items.map((c) => (
        <button key={c.id} className="sub-issue" onClick={() => useApp.getState().setOpenTicket(ticketKey('local', c.id))}>
          <span className="mono">{c.id}</span> <span className="sub-issue-title">{c.title}</span> <span className="status-name">{STATUS_LABEL[c.status]}</span>
        </button>
      ))}
    </section>
  )
}

/** « Parent » select: no ticket, or any other ticket that is not a descendant of `self`. */
function ParentSelect(props: { self: string | null; value: string | undefined; entries: Entries; onChange: (parent: string | null) => void }): React.JSX.Element {
  const all = liveTickets(props.entries)
  const banned = new Set<string>(props.self ? [props.self] : [])
  // Grows until no ticket is added: children of banned tickets are banned too.
  for (let grew = true; grew;) {
    grew = false
    for (const t of all) if (t.parent && banned.has(t.parent) && !banned.has(t.id)) { banned.add(t.id); grew = true }
  }
  const options = all.filter((t) => !banned.has(t.id))
  const missing = props.value && !all.some((t) => t.id === props.value) ? props.value : null
  return (
    <label className="prop">
      <span>Parent</span>
      <select value={props.value ?? ''} disabled={!props.self} onChange={(e) => props.onChange(e.target.value || null)}>
        <option value="">Aucun</option>
        {missing && <option value={missing}>{missing} (introuvable)</option>}
        {options.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}
      </select>
    </label>
  )
}

function Breadcrumb(props: { id: string | null; onBack: () => void }): React.JSX.Element {
  return (
    <>
      <button className="secondary editor-btn editor-back" onClick={props.onBack} title="Revenir à la liste des tickets">
        <span aria-hidden="true">←</span> Retour
      </button>
      <nav className="breadcrumb" aria-label="Fil d'Ariane">
        <button onClick={props.onBack}>Mes tickets</button>
        <span aria-hidden="true">/</span>
        {props.id ? <span className="mono" aria-current="page">{props.id}</span> : <span aria-current="page">Nouveau ticket</span>}
      </nav>
    </>
  )
}

export type FocusProps = { onFocus: () => void; onBlur: () => void }

/** The Markdown field with its toolbar; `preview` adds an « Aperçu » toggle that shows it instead of the text. */
export function Description(props: {
  value: string; focus: FocusProps; onChange: (v: string) => void; preview?: (text: string) => React.ReactNode
}): React.JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  const ids = useId()
  const [previewing, setPreviewing] = useState(false)
  const format = (f: Format): void => {
    const ta = area.current
    if (!ta) return
    const r = applyFormat(ta.value, ta.selectionStart, ta.selectionEnd, f)
    if (r.value.length > MAX_DESCRIPTION) return
    props.onChange(r.value)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.start, r.end) })
  }
  // The buttons keep the focus and the selection in the text.
  const keep = (e: React.MouseEvent): void => e.preventDefault()
  return (
    <div className="description">
      <div className="description-bar" role="toolbar" aria-label="Mise en forme">
        <label htmlFor={`${ids}-desc`}>Description</label>
        <button onMouseDown={keep} onClick={() => format('bold')} title="Gras" aria-label="Gras" disabled={previewing}><b>B</b></button>
        <button onMouseDown={keep} onClick={() => format('list')} title="Liste" aria-label="Liste" disabled={previewing}>•</button>
        <button onMouseDown={keep} onClick={() => format('code')} title="Code" aria-label="Code" className="mono" disabled={previewing}>{'</>'}</button>
        {props.preview && (
          <button className="preview-toggle" aria-pressed={previewing} onClick={() => setPreviewing(!previewing)}>Aperçu</button>
        )}
      </div>
      {previewing && props.preview
        ? <div className="description-preview">{props.preview(props.value)}</div>
        : (
          <textarea id={`${ids}-desc`} ref={area} value={props.value} maxLength={MAX_DESCRIPTION} placeholder="Décris le ticket en Markdown…"
            {...props.focus} onChange={(e) => props.onChange(e.target.value)} />
        )}
    </div>
  )
}

function Subtasks(props: { items: Subtask[]; focus: FocusProps; onChange: (items: Subtask[]) => void }): React.JSX.Element {
  const { items } = props
  /** The row being renamed; `items.length`: a new one. */
  const [editing, setEditingState] = useState<{ index: number; text: string } | null>(null)
  // Enter commits, then the blur of the input going away must not commit again.
  const current = useRef(editing)
  const setEditing = (e: { index: number; text: string } | null): void => { current.current = e; setEditingState(e) }
  const done = items.filter((s) => s.done).length

  const commit = (): void => {
    const editing = current.current
    if (!editing) return
    const text = editing.text.trim()
    setEditing(null)
    if (text !== '' && text.length <= MAX_TITLE) {
      if (editing.index >= items.length) { if (items.length < MAX_SUBTASKS) props.onChange([...items, { title: text, done: false }]) }
      else if (text !== items[editing.index]?.title) props.onChange(items.map((s, i) => (i === editing.index ? { ...s, title: text } : s)))
    }
    props.focus.onBlur()
  }
  const start = (index: number, text: string): void => { props.focus.onFocus(); setEditing({ index, text }) }
  const input = (
    <input autoFocus className="subtask-input" value={editing?.text ?? ''} aria-label="Nom de la sous-tâche" maxLength={MAX_TITLE}
      onChange={(e) => { if (current.current) setEditing({ ...current.current, text: e.target.value }) }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(null); props.focus.onBlur() }
      }} />
  )

  return (
    <section className="subtasks" aria-label="Sous-tâches">
      <div className="subtasks-head">
        <h3>Sous-tâches <span className="n">{done} / {items.length}</span></h3>
        <button className="add" disabled={items.length >= MAX_SUBTASKS} title={items.length >= MAX_SUBTASKS ? `${MAX_SUBTASKS} sous-tâches au plus` : undefined}
          onClick={() => start(items.length, '')}>+ Ajouter</button>
      </div>
      {items.map((s, i) => (
        <div key={i} className="subtask" data-done={s.done}>
          <input type="checkbox" checked={s.done} aria-label={s.title}
            onChange={(e) => props.onChange(items.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
          {editing?.index === i
            ? input
            : <button className="subtask-title" title="Renommer" onClick={() => start(i, s.title)}>{s.title || '(sans titre)'}</button>}
          <button className="subtask-del" aria-label={`Supprimer ${s.title}`} title="Supprimer"
            onClick={() => props.onChange(items.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      {editing && editing.index >= items.length && (
        <div className="subtask">
          <input type="checkbox" disabled aria-hidden="true" tabIndex={-1} />
          {input}
        </div>
      )}
    </section>
  )
}

function Labels(props: { value: string[]; known: string[]; focus: FocusProps; onChange: (l: string[]) => void }): React.JSX.Element {
  const ids = useId()
  const [adding, setAddingState] = useState<string | null>(null)
  // Enter adds, then the blur of the input going away must not add again.
  const current = useRef(adding)
  const setAdding = (a: string | null): void => { current.current = a; setAddingState(a) }
  const { value } = props
  const close = (): void => { setAdding(null); props.focus.onBlur() }
  const add = (): void => {
    if (current.current === null) return
    const l = current.current.trim()
    if (l !== '' && l.length <= MAX_LABEL && !value.includes(l) && value.length < MAX_LABELS) props.onChange([...value, l])
    close()
  }
  return (
    <div className="prop labels">
      <span>Labels</span>
      <div className="chips">
        {value.map((l) => (
          <span key={l} className="chip">
            {l}
            <button aria-label={`Retirer ${l}`} title="Retirer" onClick={() => props.onChange(value.filter((x) => x !== l))}>×</button>
          </span>
        ))}
        {adding !== null
          ? (
            <>
              <input autoFocus className="label-input" list={`${ids}-labels`} value={adding} aria-label="Nouveau label" maxLength={MAX_LABEL}
                onFocus={props.focus.onFocus}
                onChange={(e) => setAdding(e.target.value)}
                onBlur={add}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); add() }
                  if (e.key === 'Escape') { e.preventDefault(); close() }
                }} />
              <datalist id={`${ids}-labels`}>
                {props.known.filter((k) => !value.includes(k)).map((k) => <option key={k} value={k} />)}
              </datalist>
            </>
          )
          : value.length < MAX_LABELS && <button className="label-add" aria-label="Ajouter un label" title="Ajouter un label" onClick={() => setAdding('')}>+</button>}
      </div>
    </div>
  )
}
