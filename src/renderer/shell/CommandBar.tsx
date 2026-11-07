import { useEffect, useMemo, useRef, useState } from 'react'
import { matches } from '../code/FileTree'
import { preview } from '../../shared/preview'
import type { SearchHit, SymbolLocation } from '../../shared/types'
import { useApp } from '../store'

const MAX_FILES = 8
const MAX_SYMBOLS = 8
const MAX_TEXT = 10
const MIN_TEXT_QUERY = 2
const DEBOUNCE_MS = 150

interface Item { key: string; label: string; detail?: string; mono?: boolean; run: () => void }
interface Section { id: string; title: string; items: Item[]; /** The source failed: its absence of items is not an absence of results. */ error?: string }

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** Files whose path contains the characters of `query` in order, the ones named like it first. */
function rankFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  return files
    .filter((f) => matches(f, query))
    .sort((a, b) => {
      const rank = (f: string): number => (basename(f).toLowerCase().startsWith(q) ? 0 : basename(f).toLowerCase().includes(q) ? 1 : 2)
      return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)
    })
    .slice(0, MAX_FILES)
}

function useFileSection(cwd: string, query: string, open: (path: string) => void): Section {
  const [files, setFiles] = useState<string[]>([])
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    setError(undefined)
    window.canopy.listTree(cwd).then(
      (list) => { if (live) { setFiles(list); setError(undefined) } },
      (e: unknown) => { if (live) setError(`Liste des fichiers indisponible : ${errorText(e)}`) }
    )
    return () => { live = false }
  }, [cwd])
  const q = query.trim()
  const items = useMemo(() => (q === '' ? [] : rankFiles(files, q)), [files, q])
  return {
    id: 'files',
    title: 'Fichiers',
    error,
    items: items.map((p) => ({ key: p, label: p, mono: true, run: () => open(p) }))
  }
}

function useSymbolSection(cwd: string, query: string, open: (path: string, line: number) => void): Section {
  const [found, setFound] = useState<{ cwd: string; query: string; list: SymbolLocation[]; error?: string } | null>(null)
  useEffect(() => {
    if (query.length < MIN_TEXT_QUERY) return
    let live = true
    const timer = setTimeout(() => {
      window.canopy.symbols(cwd, query).then(
        (list) => { if (live && list) setFound({ cwd, query, list }) },
        (e: unknown) => { if (live) setFound({ cwd, query, list: [], error: `Recherche de symboles impossible : ${errorText(e)}` }) }
      )
    }, DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [cwd, query])
  const current = found && found.cwd === cwd && found.query === query && query.length >= MIN_TEXT_QUERY ? found : null
  return {
    id: 'symbols',
    title: 'Symboles',
    error: current?.error,
    items: (current?.list ?? []).slice(0, MAX_SYMBOLS).map((s) => ({
      key: `${s.name}:${s.path}:${s.line}:${s.column}`,
      label: s.name,
      detail: `${basename(s.path)}:${s.line}`,
      mono: true,
      run: () => open(s.path, s.line)
    }))
  }
}

function useTextSection(cwd: string, query: string, open: (path: string, line: number) => void): Section {
  const [hits, setHits] = useState<{ cwd: string; query: string; list: SearchHit[]; error?: string } | null>(null)
  useEffect(() => {
    if (query.length < MIN_TEXT_QUERY) return
    let live = true
    const timer = setTimeout(() => {
      window.canopy.searchText(cwd, query, { channel: 'bar', limit: MAX_TEXT }).then(
        (list) => { if (live && list) setHits({ cwd, query, list }) },
        (e: unknown) => { if (live) setHits({ cwd, query, list: [], error: `Recherche de texte impossible : ${errorText(e)}` }) }
      )
    }, DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [cwd, query])
  // Hits of an older query stay out until the answer for this one arrives.
  const current = hits && hits.cwd === cwd && hits.query === query && query.length >= MIN_TEXT_QUERY ? hits : null
  const list = current?.list ?? []
  return {
    id: 'text',
    title: 'Texte',
    error: current?.error,
    items: list.map((h) => ({
      key: `${h.path}:${h.line}:${h.column}`,
      label: preview(h.text),
      detail: `${basename(h.path)}:${h.line}`,
      mono: true,
      run: () => open(h.path, h.line)
    }))
  }
}

function Bar(props: { cwd: string; onClose: (restoreFocus: boolean) => void }): React.JSX.Element {
  const { cwd } = props
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const open = (path: string, line?: number): void => {
    props.onClose(false)
    useApp.getState().openInCode(cwd, path, 'code', line)
  }

  const files = useFileSection(cwd, query, open)
  const symbols = useSymbolSection(cwd, query.trim(), open)
  const text = useTextSection(cwd, query.trim(), open)
  const all = [files, symbols, text]
  const sections = all.filter((s) => s.items.length > 0)
  const failures = all.filter((s) => s.error)
  const flat = sections.flatMap((s) => s.items)

  // The answers change under the cursor: start again from the first one.
  const signature = flat.map((i) => i.key).join('\0')
  useEffect(() => { setIndex(0) }, [signature])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, signature])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Nothing typed here may reach the shortcuts behind: the composer, the editor, the Code screen.
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length > 0) setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flat[index]?.run()
    } else if (e.key === 'Tab') {
      e.preventDefault()
    }
  }

  let offset = 0
  return (
    <div className="overlay cmdbar-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(true) }}>
      <div className="cmdbar" role="dialog" aria-modal="true" aria-label="Barre de commandes" onKeyDown={onKeyDown}>
        <input autoFocus role="combobox" aria-expanded={flat.length > 0} aria-controls="cmdbar-list" aria-label="Chercher"
          aria-activedescendant={flat.length > 0 ? `cmdbar-item-${index}` : undefined}
          placeholder="Chercher un fichier, un symbole ou du texte…" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="cmdbar-list" id="cmdbar-list" role="listbox" ref={list}>
          {sections.map((s) => {
            const start = offset
            offset += s.items.length
            return (
              <div key={s.id} role="group" aria-label={s.title} data-testid={`cmdbar-${s.id}`}>
                <div className="cmdbar-section" aria-hidden="true">{s.title}</div>
                {s.items.map((item, i) => (
                  <button key={item.key} type="button" role="option" id={`cmdbar-item-${start + i}`} tabIndex={-1} className="cmdbar-item"
                    aria-selected={start + i === index} data-testid="cmdbar-item" onMouseMove={() => setIndex(start + i)} onClick={item.run}>
                    <span className={`main${item.mono ? ' mono' : ''}`}>{item.label}</span>
                    {item.detail && <span className="detail mono">{item.detail}</span>}
                  </button>
                ))}
              </div>
            )
          })}
          {failures.map((s) => <p key={s.id} className="cmdbar-empty" role="alert" data-testid="cmdbar-error">{s.error}</p>)}
          {query.trim() !== '' && flat.length === 0 && failures.length === 0 && <p className="cmdbar-empty">Aucun résultat.</p>}
        </div>
      </div>
    </div>
  )
}

/** ⌘K: files, symbols and text of the active worktree. */
export function CommandBar(): React.JSX.Element | null {
  const cwd = useApp((s) => s.worktree)
  const [shown, setShown] = useState(false)
  const before = useRef<HTMLElement | null>(null)
  const isShown = useRef(false)
  isShown.current = shown
  const close = (restoreFocus: boolean): void => {
    setShown(false)
    // Back where the user was typing (the composer), unless the choice moved them elsewhere.
    if (restoreFocus) setTimeout(() => { if (before.current?.isConnected) before.current.focus() })
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'k')) return
      // First, so that the editor's own ⌘K chord does not take it.
      e.preventDefault()
      e.stopPropagation()
      if (!useApp.getState().worktree) return
      if (isShown.current) {
        closeRef.current(true)
        return
      }
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setShown(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The worktree the bar searched is gone.
  useEffect(() => { setShown(false) }, [cwd])

  if (!shown || !cwd) return null
  return (
    <Bar key={cwd} cwd={cwd} onClose={close} />
  )
}
