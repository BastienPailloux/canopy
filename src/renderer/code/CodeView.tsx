import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BaseContent, FileContent } from '../../shared/api'
import { isFileChanged } from '../../shared/errors'
import type { BaseRef, ChangedFile } from '../../shared/types'
import { lineDiff } from '../sessions/lineDiff'
import { askClaude } from '../sessions/sessionStore'
import { useApp } from '../store'
import { askMessage } from './askMessage'
import type { DiffStatus } from './diffOutcome'
import { dropDraft, getDraft, setDraft } from './drafts'
import { CodeEditor, DiffPane, type EditorHandle, type Navigate, type Reveal, type Selection } from './Editors'

export type Mode = 'code' | 'diff'

type Work = FileContent | { kind: 'missing' } | { kind: 'error'; message: string }
interface Loaded { work: Work; base: BaseContent | null | undefined }

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))
const megabytes = (size: number): string => `${(size / 1024 / 1024).toFixed(1)} Mo`

async function load(cwd: string, base: BaseRef, path: string, change: ChangedFile | undefined): Promise<Loaded> {
  const [work, baseContent] = await Promise.all([
    window.canopy.readFile(cwd, path).catch((e: unknown): Work =>
      change?.kind === 'D' ? { kind: 'missing' } : { kind: 'error', message: errorText(e) }),
    change ? window.canopy.readBase(cwd, base.ref, change.oldPath ?? path).catch((): undefined => undefined) : Promise.resolve(undefined)
  ])
  return { work, base: baseContent }
}

/** 1-based lines of `after` that `before` does not have. */
function addedLines(before: string, after: string): number[] {
  const added: number[] = []
  let line = 0
  for (const l of lineDiff(before, after)) {
    if (l.kind === 'del') continue
    line++
    if (l.kind === 'add') added.push(line)
  }
  return added
}

function Message(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="code-message" role="status">{props.children}</div>
}

function Badge(props: { change: ChangedFile | undefined; base: BaseRef }): React.JSX.Element {
  const { change } = props
  if (!change) return <span className="badge same">identique à {props.base.name}</span>
  const stat = change.unreadable ? 'illisible' : change.size !== undefined ? `trop volumineux · ${megabytes(change.size)}` : change.binary ? 'binaire' : [change.added > 0 && `+${change.added}`, change.deleted > 0 && `−${change.deleted}`].filter(Boolean).join(' ')
  const label = { A: 'ajouté', M: 'modifié', D: 'supprimé', R: `renommé de ${change.oldPath ?? ''}` }[change.kind]
  return <span className="badge changed" data-testid="file-badge">{label}{stat && <> · <span className="mono">{stat}</span></>}</span>
}

function AskForm(props: { path: string; selection: Selection | null; onSend: (text: string) => void; onCancel: () => void }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const { selection } = props
  return (
    <form className="ask-form" onSubmit={(e) => { e.preventDefault(); if (question.trim()) props.onSend(askMessage(props.path, selection, question)) }}>
      <span className="ask-context mono">
        {props.path}{selection && ` · ${selection.startLine === selection.endLine ? `ligne ${selection.startLine}` : `lignes ${selection.startLine}–${selection.endLine}`}`}
      </span>
      <textarea autoFocus aria-label="Question pour Claude" placeholder="Que veux-tu demander à Claude ?" rows={3} value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); if (e.key === 'Escape') props.onCancel() }} />
      <span className="row">
        <button type="submit" className="primary" disabled={question.trim() === ''}>Envoyer</button>
        <button type="button" onClick={props.onCancel}>Annuler</button>
      </span>
    </form>
  )
}

/** One file of the worktree: its content or its diff, editable. Remount it (by `key`) for another file. */
export function CodeView(props: {
  cwd: string
  base: BaseRef
  path: string
  change: ChangedFile | undefined
  mode: Mode
  onMode: (m: Mode) => void
  /** Changes whenever the lists were refreshed: the file may have changed too. */
  tick: number
  onSaved: () => void
  reveal?: Reveal
  onNavigate: Navigate
}): React.JSX.Element {
  const { cwd, base, path, change } = props
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [asking, setAsking] = useState<Selection | null | false>(false)
  const [diffStatus, setDiffStatus] = useState<DiffStatus>('complete')
  const handle = useRef<EditorHandle | null>(null)
  const state = useRef({ loaded, text })
  state.current = { loaded, text }

  const saved = loaded?.work.kind === 'text' ? loaded.work : null
  const dirty = saved !== null && text !== saved.content
  // Kept outside the view: it is gone when the user switches to Sessions or another worktree.
  useEffect(() => {
    if (!saved) return
    if (dirty) setDraft(cwd, path, { text, version: saved.version })
    else dropDraft(cwd, path)
  }, [cwd, path, dirty, text, saved])

  // The buffer follows the disk until the user has typed: after that, a change on disk is a conflict.
  useEffect(() => {
    let live = true
    void load(cwd, base, path, change).then((next) => {
      if (!live) return
      const { loaded: prev, text: buffer } = state.current
      const prevText = prev?.work.kind === 'text' ? prev.work : null
      const draft = prev ? undefined : getDraft(cwd, path)
      if (draft && next.work.kind === 'text') {
        // Back on a file with unsaved typing: the buffer is the user's, the disk may have moved on.
        // The version stays the one typed over, so that saving still notices a change on disk.
        setLoaded({ ...next, work: { ...next.work, version: draft.version } })
        setText(draft.text)
        setEditing(true)
        setDiskChanged(next.work.version !== draft.version)
        return
      }
      const untouched = !prevText || buffer === prevText.content
      if (untouched || next.work.kind !== 'text') {
        setLoaded(next)
        setText(next.work.kind === 'text' ? next.work.content : '')
        setDiskChanged(false)
      } else {
        setLoaded({ ...next, work: prevText })
        if (next.work.version !== prevText.version) setDiskChanged(true)
      }
    })
    return () => { live = false }
    // `change` and `base` come with each `tick`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, base.ref, path, props.tick])

  const save = useCallback(async (force: boolean): Promise<void> => {
    const { loaded: cur, text: buffer } = state.current
    if (cur?.work.kind !== 'text') return
    try {
      const version = await window.canopy.writeFile(cwd, path, buffer, force ? undefined : cur.work.version)
      setLoaded({ ...cur, work: { kind: 'text', content: buffer, version } })
      setSaveError(null)
      setDiskChanged(false)
      props.onSaved()
    } catch (e) {
      if (isFileChanged(e)) setDiskChanged(true)
      else setSaveError(`Enregistrement impossible : ${errorText(e)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, path])

  const reloadFromDisk = async (): Promise<void> => {
    const next = await load(cwd, base, path, change)
    setLoaded(next)
    setText(next.work.kind === 'text' ? next.work.content : '')
    setDiskChanged(false)
    setSaveError(null)
  }

  const mode: Mode = change ? props.mode : 'code'
  const baseText = loaded?.base?.kind === 'text' ? loaded.base.content : loaded?.base === null ? '' : null
  const added = useMemo(
    () => (saved && baseText !== null && change ? addedLines(baseText, saved.content) : []),
    [saved, baseText, change]
  )

  const send = (message: string): void => {
    askClaude(cwd, message)
    useApp.getState().setView('sessions')
  }

  const lastSlash = path.lastIndexOf('/')
  const work = loaded?.work
  // Reached through a definition: someone else's code, not part of the worktree's own files.
  const vendored = path.split('/').includes('node_modules')

  let body: React.ReactNode
  if (!loaded || !work) body = <Message>Chargement…</Message>
  else if (work.kind === 'error') body = <Message>Lecture impossible : {work.message}</Message>
  else if (mode === 'diff') {
    const b = loaded.base
    if (work.kind === 'binary') body = <Message>Fichier binaire : pas de diff.</Message>
    else if (work.kind === 'tooLarge') body = <Message>Fichier trop volumineux ({megabytes(work.size)}) : pas de diff.</Message>
    else if (b === undefined) body = <Message>Version de {base.name} illisible.</Message>
    else if (b !== null && b.kind === 'tooLarge') body = <Message>La version de {base.name} est trop volumineuse ({megabytes(b.size)}) : pas de diff.</Message>
    else if (b !== null && b.kind === 'notBlob') body = <Message>Sur {base.name}, ce chemin est un dossier ou un sous-module : pas de diff.</Message>
    else body = <DiffPane path={path} original={b?.kind === 'text' ? b.content : ''} modified={work.kind === 'text' ? text : ''} onNavigate={props.onNavigate} onStatus={setDiffStatus} handle={handle} />
  } else if (work.kind === 'missing') body = <Message>Ce fichier est supprimé depuis {base.name}. Le diff montre ce qui disparaît.</Message>
  else if (work.kind === 'binary') body = <Message>Fichier binaire : pas d'aperçu.</Message>
  else if (work.kind === 'tooLarge') body = <Message>Fichier trop volumineux ({megabytes(work.size)}) : pas d'aperçu.</Message>
  else body = <CodeEditor path={path} value={text} readOnly={!editing} addedLines={added} onChange={setText} onSave={() => void save(false)} reveal={props.reveal} onNavigate={props.onNavigate} handle={handle} />

  return (
    <section className="code-view" aria-label="Contenu du fichier">
      <div className="file-head">
        <span className="file-path mono"><span className="dir">{lastSlash >= 0 ? path.slice(0, lastSlash + 1) : ''}</span>{path.slice(lastSlash + 1)}</span>
        {loaded && <Badge change={change} base={base} />}
        {dirty && <span className="badge changed">non enregistré</span>}
        {(vendored || saved?.notUtf8) && <span className="badge same" data-testid="read-only">lecture seule</span>}
        <div className="file-actions">
          <div role="group" aria-label="Mode d'affichage" className="seg">
            <button type="button" aria-pressed={mode === 'code'} onClick={() => props.onMode('code')}>Code</button>
            <button type="button" aria-pressed={mode === 'diff'} disabled={!change || dirty}
              title={dirty ? "Enregistre d'abord" : undefined} onClick={() => props.onMode('diff')}>Diff vs {base.name}</button>
          </div>
          <button type="button" disabled={!loaded || work?.kind === 'error'}
            onClick={() => setAsking(asking === false ? handle.current?.selection() ?? null : false)}>Demander à Claude</button>
          {mode === 'code' && work?.kind === 'text' && !vendored && !work.notUtf8 && (editing ? (
            <>
              <button type="button" className="primary" disabled={!dirty} onClick={() => void save(false)}>Enregistrer <span className="kbd">⌘S</span></button>
              <button type="button" onClick={() => { setText(work.content); setEditing(false); setDiskChanged(false) }}>Annuler</button>
            </>
          ) : <button type="button" onClick={() => setEditing(true)}>Modifier</button>)}
        </div>
      </div>
      {diskChanged && (
        <div className="code-warning" role="alert" data-testid="disk-changed">
          <span>Ce fichier a changé sur le disque depuis son ouverture (Claude, un autre outil…). Rien n'a été écrasé.</span>
          <button type="button" onClick={() => void reloadFromDisk()}>Recharger (perdre mes modifications)</button>
          {dirty && <button type="button" onClick={() => void save(true)}>Écraser quand même</button>}
        </div>
      )}
      {saveError && <div className="code-warning" role="alert">{saveError}</div>}
      {saved?.notUtf8 && <div className="code-warning" role="status" data-testid="not-utf8">Ce fichier n'est pas en UTF-8 : il s'affiche en lecture seule, car l'enregistrer le corromprait.</div>}
      {diffStatus === 'computing' && <div className="code-warning" role="status" data-testid="diff-computing">Calcul du diff en cours : ce qui s'affiche n'est pas encore le résultat.</div>}
      {diffStatus === 'abandoned' && (
        <div className="code-warning" role="alert" data-testid="diff-abandoned">
          Diff incomplet : le calcul a été abandonné (fichier trop complexe). Ce qui s'affiche peut être partiel ou inexact.
        </div>
      )}
      {asking !== false && <AskForm path={path} selection={asking} onSend={send} onCancel={() => setAsking(false)} />}
      <div className="code-body">{body}</div>
    </section>
  )
}
