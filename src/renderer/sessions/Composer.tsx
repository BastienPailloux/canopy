import type { ModelInfo, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SESSION_MODES } from '../../shared/sessionOptions'
import { ACCEPTED_TYPES, readDocument, readImage, sortFiles } from './attachments'
import { applyCompletion, filterCommands, filterFiles, findTrigger, wantsProcess, type Trigger } from './completion'
import { interrupt, setDraftDocuments, setDraftImages, setDraftText, setMode, setModel, submit, useSessions, warmUp, type SessionTab } from './sessionStore'

/** Until a session can list its own models. */
const MODEL_ALIASES: Pick<ModelInfo, 'value' | 'displayName'>[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' }
]

const clipIcon = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6" />
  </svg>
)

const micIcon = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)

/** The last focus request carried out, across mounts: the composer mounts again on every return to Sessions. */
let handledFocus = 0

interface Suggestion { value: string; label: string; detail?: string }

/** The worktree's files, read again each time a `@` opens the list. */
function useFiles(cwd: string, wanted: boolean): string[] {
  const [files, setFiles] = useState<string[]>([])
  useEffect(() => {
    if (!wanted) return
    let live = true
    window.canopy.listTree(cwd).then((list) => { if (live) setFiles(list) }, () => undefined)
    return () => { live = false }
  }, [cwd, wanted])
  return files
}

function suggestionsFor(trigger: Trigger | null, files: string[], tab: SessionTab): Suggestion[] {
  if (trigger?.kind === 'file') {
    return filterFiles(files, trigger.query).map((f) => ({ value: `@${f}`, label: f }))
  }
  if (trigger?.kind === 'command') {
    return filterCommands(tab.commands, trigger.query).map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, detail: c.description }))
  }
  return []
}

export function Composer(props: { tab: SessionTab; worktreeLabel: string }): React.JSX.Element {
  const { tab, worktreeLabel } = props
  const { draft } = tab
  const input = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const documents = draft.documents ?? []

  const focusRequest = useSessions((s) => s.focusRequest)
  const dictate = (): void => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    // macOS types into the field that holds the focus; the text is only inserted, never sent.
    void window.canopy.startDictation().catch(() => undefined)
  }
  useEffect(() => {
    if (!focusRequest || focusRequest.cwd !== tab.cwd || focusRequest.seq <= handledFocus) return
    handledFocus = focusRequest.seq
    const el = input.current
    if (!el) return
    if (focusRequest.dictate) { dictate(); return }
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })

  const trigger = useMemo(() => (dismissed ? null : findTrigger(draft.text, caret)), [dismissed, draft.text, caret])
  const files = useFiles(tab.cwd, trigger?.kind === 'file')
  const suggestions = suggestionsFor(trigger, files, tab)
  const selected = Math.min(highlight, Math.max(suggestions.length - 1, 0))
  const busy = tab.state === 'running' || tab.state === 'waiting'
  const models = tab.models.length > 0 ? tab.models : MODEL_ALIASES
  const canSend = draft.text.trim() !== '' || draft.images.length > 0 || documents.length > 0

  // Commands come from a running process: the first command name typed starts it.
  const wantsCommands = wantsProcess(trigger) && !tab.localId
  useEffect(() => {
    if (wantsCommands) warmUp(tab.id)
  }, [wantsCommands, tab.id])

  const setText = (text: string, at: number): void => {
    setDraftText(tab.id, text)
    setCaret(at)
    setHighlight(0)
    setDismissed(false)
  }

  const accept = (s: Suggestion): void => {
    if (!trigger) return
    const next = applyCompletion(draft.text, caret, trigger, s.value)
    setText(next.text, next.caret)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      void submit(tab.id)
      return
    }
    if (suggestions.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : suggestions.length - 1
      setHighlight((selected + step) % suggestions.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      accept(suggestions[selected])
    } else if (e.key === 'Escape') {
      setDismissed(true)
    }
  }

  const attach = (files: File[]): void => {
    if (files.length === 0) return
    const sorted = sortFiles(files)
    setAttachError(sorted.error)
    const failed = (err: unknown): void => setAttachError(err instanceof Error ? err.message : String(err))
    void Promise.all(sorted.images.map(readImage)).then(
      (images) => { if (images.length) setDraftImages(tab.id, (current) => [...current, ...images]) }, failed)
    void Promise.all(sorted.documents.map(readDocument)).then(
      (docs) => { if (docs.length) setDraftDocuments(tab.id, (current) => [...current, ...docs]) }, failed)
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const pasted = [...e.clipboardData.files]
    if (pasted.length === 0) return
    // Text copied along with a file still goes in the box, by the browser's own paste.
    if (e.clipboardData.getData('text/plain') === '') e.preventDefault()
    attach(pasted)
  }

  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  const onDragOver = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDrop = (e: React.DragEvent): void => {
    setDragging(false)
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    attach([...e.dataTransfer.files])
  }

  return (
    <div className="composer-wrap">
      {tab.error && <p className="session-error" role="alert">{tab.error}</p>}
      <div className={dragging ? 'composer dragging' : 'composer'} onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }} onDrop={onDrop}>
        {suggestions.length > 0 && (
          <div className="suggestions" role="listbox" aria-label={trigger?.kind === 'file' ? 'Fichiers' : 'Commandes'}>
            {suggestions.map((s, i) => (
              <button key={s.value} type="button" role="option" aria-selected={i === selected}
                onMouseDown={(e) => e.preventDefault()} onClick={() => accept(s)}>
                <span className="mono">{s.label}</span>
                {s.detail && <span className="muted">{s.detail}</span>}
              </button>
            ))}
          </div>
        )}
        <label htmlFor="composer">Message à Claude · {worktreeLabel}</label>
        {draft.images.length > 0 && (
          <div className="thumbs">
            {draft.images.map((img, i) => (
              <span key={i} className="thumb">
                <img alt={`Image ${i + 1}`} src={`data:${img.mediaType};base64,${img.base64}`} />
                <button type="button" aria-label={`Retirer l'image ${i + 1}`}
                  onClick={() => setDraftImages(tab.id, (current) => current.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        {documents.length > 0 && (
          <div className="doc-chips">
            {documents.map((d, i) => (
              <span key={i} className="doc-chip" title={d.name}>
                <span className="doc-chip-kind">PDF</span>
                <span className="doc-chip-name">{d.name}</span>
                <button type="button" aria-label={`Retirer ${d.name}`}
                  onClick={() => setDraftDocuments(tab.id, (current) => current.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachError && <span className="del">{attachError}</span>}
        <textarea id="composer" ref={input} rows={2} value={draft.text} spellCheck={false}
          placeholder="Demande une suite, colle une erreur, ou tape / pour une commande"
          onChange={(e) => setText(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown} onPaste={onPaste} />
        <div className="composer-bar">
          <button type="button" className="icon-btn" aria-label="Joindre un fichier" title="Joindre une image ou un PDF"
            onClick={() => picker.current?.click()}>{clipIcon}</button>
          <button type="button" className="icon-btn" aria-label="Dicter" title="Dicter (⇧⌘D)" onClick={dictate}>{micIcon}</button>
          <input ref={picker} type="file" multiple hidden accept={ACCEPTED_TYPES} data-testid="attach-input"
            onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = '' }} />
          <select aria-label="Mode" value={tab.mode} onChange={(e) => setMode(tab.id, e.target.value as PermissionMode)}>
            {SESSION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select aria-label="Modèle" value={tab.model ?? ''} onChange={(e) => { if (e.target.value) setModel(tab.id, e.target.value) }}>
            {!tab.model && <option value="">Modèle par défaut</option>}
            {tab.model && !models.some((m) => m.value === tab.model) && <option value={tab.model}>{tab.model}</option>}
            {models.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
          </select>
          <span className="spacer" />
          {busy && tab.localId && <button type="button" className="secondary" onClick={() => interrupt(tab.id)}>Interrompre</button>}
          <button type="button" className="primary send" disabled={!canSend} onClick={() => void submit(tab.id)}>Envoyer ⌘↵</button>
        </div>
      </div>
    </div>
  )
}
