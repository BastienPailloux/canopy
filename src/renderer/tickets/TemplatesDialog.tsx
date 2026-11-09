import { useEffect, useRef, useState } from 'react'
import {
  MAX_TEMPLATE_NAME, PRIORITIES, PRIORITY_LABEL,
  type TemplateFields, type TemplateList, type TicketPriority, type TicketTemplate,
} from '../../shared/tickets'
import { useModal } from '../shell/useModal'
import { closeSaver, createSaver, notifySavers, trackSaver, type Saver } from './editorSave'
import { TEMPLATES_CHANGED } from './templateDraft'
import { Description, Labels, Subtasks } from './TicketEditor'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

/** The fields alone: main refuses any other key, `slug` included. */
function fieldsOf(t: TemplateFields): TemplateFields {
  const f: TemplateFields = { name: t.name, description: t.description, priority: t.priority, labels: t.labels, subtasks: t.subtasks }
  if (t.order !== undefined) f.order = t.order
  return f
}

const changed = (): void => { window.dispatchEvent(new Event(TEMPLATES_CHANGED)) }

const copyName = (name: string): string => `${name} (copie)`.slice(0, MAX_TEMPLATE_NAME)

/** What the dialog asks of the editor shown: its fields, written first, or forgotten before a delete. */
interface EditorHandle {
  /** Writes what is pending, creating the template if it is new; resolves to its slug. */
  save(): Promise<string>
  fields(): TemplateFields
  /** The template is being deleted: nothing pending is written any more. */
  discard(): void
}

/** The template edited: `slug` null for a new one not written yet. `n` changes when another one is opened. */
interface Selection { slug: string | null; n: number; initial?: TemplateFields }

/** « Modèles de tickets »: the templates of `repo` on the left, the one selected edited on the right, saved as it is typed. */
export function TemplatesDialog({ repo, onClose }: { repo: string; onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<TemplateList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [liveName, setLiveName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const editor = useRef<EditorHandle | null>(null)

  const seq = useRef(0)
  const load = async (): Promise<void> => {
    const n = ++seq.current
    try {
      const l = await window.canopy.ticketTemplates(repo)
      if (n === seq.current) setList(l)
    } catch (e) {
      if (n === seq.current) setError(message(e))
    }
  }
  // Template changes, ours and those made outside Canopy, come back as `tickets:changed`.
  useEffect(() => {
    void load()
    return window.canopy.on('tickets:changed', () => { void load() })
  }, [repo])

  const templates = list?.entries.flatMap((e) => (e.kind === 'template' ? [e.template] : [])) ?? []
  const unreadable = list?.entries.flatMap((e) => (e.kind === 'unreadable' ? [e] : [])) ?? []
  const disk = selected?.slug ? templates.find((t) => t.slug === selected.slug) : undefined

  const open = (slug: string | null, initial?: TemplateFields): void => {
    setLiveName(null)
    setSelected((s) => ({ slug, n: (s?.n ?? 0) + 1, initial }))
  }
  // First the default, and another one when the template shown is deleted from outside. A new one is kept: a read
  // started before it was written does not have it yet.
  useEffect(() => {
    if (!list || (selected && (disk || selected.initial))) return
    const next = templates.find((t) => t.slug === list.defaultSlug) ?? templates[0]
    if (next) open(next.slug)
    else if (selected) setSelected(null)
  }, [list])

  const nextOrder = (): number => Math.max(0, ...templates.map((t) => t.order ?? 0)) + 1

  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(message(e))
    } finally {
      changed()
      setBusy(false)
    }
  }

  const add = (): void => open(null, { name: 'Nouveau modèle', order: nextOrder(), description: '', priority: 'none', labels: [], subtasks: [] })

  const duplicate = (): Promise<void> => act(async () => {
    const e = editor.current
    if (!e) return
    await e.save()
    const copy = await window.canopy.saveTicketTemplate(repo, null, { ...fieldsOf(e.fields()), name: copyName(e.fields().name), order: nextOrder() })
    await load()
    open(copy.slug)
  })

  const remove = (): Promise<void> => act(async () => {
    const e = editor.current
    if (!selected || !e) return
    const name = e.fields().name
    if (!window.confirm(`Supprimer le modèle « ${name} » ?`)) return
    const at = templates.findIndex((t) => t.slug === selected.slug)
    const rest = templates.filter((t) => t.slug !== selected.slug)
    e.discard()
    if (selected.slug) await window.canopy.deleteTicketTemplate(repo, selected.slug)
    const next = rest[Math.min(Math.max(at, 0), rest.length - 1)]
    if (next) open(next.slug)
    else setSelected(null)
    await load()
  })

  const makeDefault = (): Promise<void> => act(async () => {
    const slug = await editor.current?.save()
    if (!slug) return
    await window.canopy.setDefaultTicketTemplate(repo, slug)
    await load()
  })

  // Every readable template gets its place, 1..n: those without an `order` until now included.
  const move = (by: -1 | 1): Promise<void> => act(async () => {
    const slug = await editor.current?.save()
    if (!slug) return
    const fresh = (await window.canopy.ticketTemplates(repo)).entries.flatMap((e) => (e.kind === 'template' ? [e.template] : []))
    const at = fresh.findIndex((t) => t.slug === slug)
    const to = at + by
    if (at === -1 || to < 0 || to >= fresh.length) return
    ;[fresh[at], fresh[to]] = [fresh[to], fresh[at]]
    for (const [i, t] of fresh.entries()) {
      if (t.order !== i + 1) await window.canopy.saveTicketTemplate(repo, t.slug, { ...fieldsOf(t), order: i + 1 })
    }
    await load()
  })

  const dialog = useRef<HTMLDivElement>(null)
  useModal(dialog, onClose)

  const at = selected?.slug ? templates.findIndex((t) => t.slug === selected.slug) : -1
  const isDefault = !!selected?.slug && selected.slug === list?.defaultSlug
  const shownName = (t: TicketTemplate): string => (t.slug === selected?.slug && liveName?.trim() ? liveName : t.name)

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialog} className="dialog templates-dialog" role="dialog" aria-modal="true" aria-label="Modèles de tickets">
        <h2>Modèles de tickets</h2>
        <div className="templates-body">
          <div className="templates-side">
            <ul className="templates-list" aria-label="Modèles">
              {templates.map((t) => (
                <li key={t.slug}>
                  <button type="button" aria-current={t.slug === selected?.slug || undefined} onClick={() => open(t.slug)}>
                    <span className="templates-name">{shownName(t)}</span>
                    {t.slug === list?.defaultSlug && <>{' '}<span className="templates-default">Par défaut</span></>}
                  </button>
                </li>
              ))}
              {selected && selected.slug === null && (
                <li><button type="button" aria-current="true"><span className="templates-name">{liveName?.trim() || selected.initial?.name}</span></button></li>
              )}
              {unreadable.map((u) => (
                <li key={u.file} className="templates-unreadable" title={u.error}>
                  <span className="mono">{u.file}</span>
                  <span className="error">Illisible : {u.error}</span>
                </li>
              ))}
            </ul>
            <div className="templates-actions">
              <button type="button" className="secondary" disabled={busy} onClick={add}>+ Nouveau modèle</button>
              <button type="button" className="secondary" disabled={busy || !selected} onClick={() => void duplicate()}>Dupliquer</button>
              <button type="button" className="secondary" disabled={busy || !selected} onClick={() => void remove()}>Supprimer</button>
              <button type="button" className="secondary" disabled={busy || !selected || isDefault} onClick={() => void makeDefault()}>Définir par défaut</button>
              <button type="button" className="secondary" disabled={busy || at <= 0} onClick={() => void move(-1)}>Monter</button>
              <button type="button" className="secondary" disabled={busy || at === -1 || at >= templates.length - 1} onClick={() => void move(1)}>Descendre</button>
            </div>
          </div>
          {/* A new template keeps its editor while the list has not read it back yet. */}
          {selected && (disk ?? selected.initial)
            ? (
              <TemplateEditor key={selected.n} repo={repo} slug={selected.slug} initial={(disk ?? selected.initial)!} disk={disk}
                handle={editor} onName={setLiveName}
                onCreated={(slug) => setSelected((s) => (s ? { ...s, slug } : s))} />
            )
            : <p className="templates-empty">{list ? 'Aucun modèle : « + Nouveau modèle » en crée un.' : 'Chargement…'}</p>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  )
}

/** One template, saved as it is edited; a new one is written on its first change, under a slug taken from its name then. */
function TemplateEditor(props: {
  repo: string; slug: string | null; initial: TemplateFields; disk: TicketTemplate | undefined
  handle: React.RefObject<EditorHandle | null>; onName: (name: string) => void; onCreated: (slug: string) => void
}): React.JSX.Element {
  const { repo } = props
  const [form, setForm] = useState<TemplateFields>(() => fieldsOf(props.initial))
  const [saveError, setSaveError] = useState<string | null>(null)
  const local = useRef(form)
  /** The last name not empty: an emptied name goes back to it when the field is left, and is what a new template is created under. */
  const lastName = useRef(form.name)
  const slug = useRef(props.slug)
  const disk = useRef(props.disk)
  disk.current = props.disk
  const focused = useRef<keyof TemplateFields | null>(null)
  const gone = useRef(false)
  const live = useRef(true)

  const show = (f: TemplateFields): void => {
    local.current = f
    if (f.name.trim() !== '') lastName.current = f.name
    setForm(f)
    props.onName(f.name)
  }

  const save = async (changes: Partial<TemplateFields>): Promise<void> => {
    if (gone.current) return
    if (slug.current) {
      // Onto the last version read, so a field changed outside Canopy and not here is kept.
      await window.canopy.saveTicketTemplate(repo, slug.current, fieldsOf({ ...(disk.current ?? local.current), ...changes }))
    } else {
      const created = await window.canopy.saveTicketTemplate(repo, null, fieldsOf({ ...local.current, name: lastName.current }))
      slug.current = created.slug
      if (live.current) props.onCreated(created.slug)
    }
    changed()
    if (live.current) setSaveError(null)
  }
  const saver = useRef<Saver<TemplateFields>>(null as unknown as Saver<TemplateFields>)
  saver.current ??= createSaver<TemplateFields>((c) => save(c), 500, {
    onError: (e) => { if (live.current) setSaveError(message(e)) },
    onPending: notifySavers
  })

  useEffect(() => {
    live.current = true
    const s = saver.current
    // Counted with the ticket editors: quitting or updating now writes it first.
    trackSaver(s as unknown as Saver)
    return () => {
      live.current = false
      void closeSaver(s, () => !live.current)
    }
  }, [])

  // A version from disk: fields being typed or in focus keep what shows.
  useEffect(() => {
    const d = props.disk
    if (!d) return
    const keep = saver.current.pending()
    if (focused.current) keep.add(focused.current)
    const next: TemplateFields = fieldsOf(d)
    for (const k of keep) (next as unknown as Record<string, unknown>)[k] = local.current[k]
    show(next)
  }, [props.disk])

  props.handle.current = {
    save: async () => {
      if (!(await saver.current.flush())) throw new Error('Les dernières modifications ne sont pas enregistrées : action annulée.')
      if (!slug.current) await save({})
      if (!slug.current) throw new Error('Le modèle n’a pas pu être créé.')
      return slug.current
    },
    fields: () => ({ ...local.current, name: lastName.current }),
    discard: () => { gone.current = true; saver.current.dispose() }
  }

  const update = (c: Partial<TemplateFields>): void => {
    show({ ...local.current, ...c })
    const { name, ...rest } = c
    // An empty name is never written: main refuses it, and the last one comes back on leaving the field.
    saver.current.change(name !== undefined && name.trim() !== '' ? c : rest)
  }
  const focus = (k: keyof TemplateFields) => ({
    onFocus: () => { focused.current = k },
    onBlur: () => { if (focused.current === k) focused.current = null }
  })

  const [known, setKnown] = useState<string[]>([])
  useEffect(() => {
    let on = true
    window.canopy.ticketLabels(repo).then((l) => { if (on) setKnown(l) }, () => {})
    return () => { on = false }
  }, [repo])

  const nameEmpty = form.name.trim() === ''
  return (
    <div className="templates-editor">
      {saveError && <p className="error" role="alert">Enregistrement impossible : {saveError}</p>}
      <label>
        Nom
        <input value={form.name} maxLength={MAX_TEMPLATE_NAME} spellCheck={false} aria-invalid={nameEmpty || undefined}
          {...focus('name')}
          onChange={(e) => update({ name: e.target.value })}
          onBlur={() => {
            if (focused.current === 'name') focused.current = null
            if (local.current.name.trim() === '') show({ ...local.current, name: lastName.current })
          }} />
      </label>
      {nameEmpty && <p className="templates-hint">Un modèle garde un nom : l’ancien revient en quittant le champ.</p>}
      <Description value={form.description} focus={focus('description')} onChange={(description) => update({ description })} />
      <div className="editor-side templates-props">
        <label className="prop">
          <span>Priorité</span>
          <select value={form.priority} onChange={(e) => update({ priority: e.target.value as TicketPriority })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </label>
        <Labels value={form.labels} known={known} focus={focus('labels')} onChange={(labels) => update({ labels })} />
      </div>
      <Subtasks items={form.subtasks} focus={focus('subtasks')} onChange={(subtasks) => update({ subtasks })} />
    </div>
  )
}
