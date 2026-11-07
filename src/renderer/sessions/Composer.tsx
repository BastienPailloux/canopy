import type { ModelInfo, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { applyCompletion, filterCommands, filterFiles, findTrigger, wantsProcess, type Trigger } from './completion'
import { interrupt, setDraftImages, setDraftText, setMode, setModel, submit, warmUp, type SessionTab } from './sessionStore'
import type { UserImage } from './transcript'

/** `bypassPermissions` is left out on purpose: the main process rejects it. */
const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Mode : demander' },
  { value: 'acceptEdits', label: 'Mode : accepter les edits' },
  { value: 'plan', label: 'Mode : plan' },
  { value: 'dontAsk', label: 'Mode : refuser sans demander' },
  { value: 'auto', label: 'Mode : auto' }
]

/** Until a session can list its own models. */
const MODEL_ALIASES: Pick<ModelInfo, 'value' | 'displayName'>[] = [
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' }
]

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

interface Suggestion { value: string; label: string; detail?: string }

function readImage(file: File): Promise<UserImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ mediaType: file.type, base64: String(reader.result).split(',')[1] ?? '' })
    reader.onerror = () => reject(reader.error ?? new Error('Image illisible'))
    reader.readAsDataURL(file)
  })
}

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
  const [imageError, setImageError] = useState<string | null>(null)

  const trigger = useMemo(() => (dismissed ? null : findTrigger(draft.text, caret)), [dismissed, draft.text, caret])
  const files = useFiles(tab.cwd, trigger?.kind === 'file')
  const suggestions = suggestionsFor(trigger, files, tab)
  const selected = Math.min(highlight, Math.max(suggestions.length - 1, 0))
  const busy = tab.state === 'running' || tab.state === 'waiting'
  const models = tab.models.length > 0 ? tab.models : MODEL_ALIASES
  const canSend = draft.text.trim() !== '' || draft.images.length > 0

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

  const onPaste = (e: React.ClipboardEvent): void => {
    const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (pasted.length === 0) return
    e.preventDefault()
    const usable = pasted.filter((f) => IMAGE_TYPES.includes(f.type))
    setImageError(usable.length < pasted.length ? 'Seules les images PNG, JPEG, GIF et WebP sont acceptées.' : null)
    void Promise.all(usable.map(readImage)).then(
      (images) => setDraftImages(tab.id, (current) => [...current, ...images]),
      (err: unknown) => setImageError(err instanceof Error ? err.message : String(err))
    )
  }

  return (
    <div className="composer-wrap">
      {tab.error && <p className="session-error" role="alert">{tab.error}</p>}
      <div className="composer">
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
        {imageError && <span className="del">{imageError}</span>}
        <textarea id="composer" ref={input} rows={2} value={draft.text} spellCheck={false}
          placeholder="Demande une suite, colle une erreur, ou tape / pour une commande"
          onChange={(e) => setText(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown} onPaste={onPaste} />
        <div className="composer-bar">
          <select aria-label="Mode" value={tab.mode} onChange={(e) => setMode(tab.id, e.target.value as PermissionMode)}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
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
