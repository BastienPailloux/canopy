import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import { CodeView, type Mode } from './CodeView'
import type { Reveal } from './Editors'
import { getShown, setShown } from './drafts'
import { FileTree } from './FileTree'
import { SearchPanel } from './SearchPanel'
import { useCodeData } from './useCodeData'
import './code.css'

const UNKNOWN_BASE = 'Branche de comparaison inconnue'

export function CodeScreen(props: { cwd: string; branch: string }): React.JSX.Element {
  const { cwd } = props
  const [pickedBase, setPickedBase] = useState<string | undefined>()
  const [back] = useState(() => getShown(cwd))
  const [scope, setScope] = useState<'all' | 'changed'>(back?.scope ?? 'all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(back?.selected ?? null)
  const [mode, setMode] = useState<Mode>(back?.mode ?? 'code')
  useEffect(() => { setShown(cwd, { selected, mode, scope }) }, [cwd, selected, mode, scope])
  const data = useCodeData(cwd, pickedBase)
  const filter = useRef<HTMLInputElement>(null)
  const [baseNotice, setBaseNotice] = useState<string | null>(null)
  const request = useApp((s) => s.codeRequest)
  const [panel, setPanel] = useState<'files' | 'search'>('files')
  const searchInput = useRef<HTMLInputElement>(null)
  const [reveal, setReveal] = useState<Reveal | undefined>()
  const select = (path: string): void => { setReveal(undefined); setSelected(path) }

  // A tool card asked for a file, possibly before the changed list was known: the request waits for it.
  useEffect(() => {
    if (!request || request.cwd !== cwd || data.loading) return
    useApp.getState().clearCodeRequest(request.seq)
    setSelected(request.path)
    setReveal(request.line === undefined ? undefined : { line: request.line, seq: request.seq })
    setMode(request.mode)
    setScope(data.files.some((f) => f.path === request.path) ? 'changed' : 'all')
    setQuery('')
  }, [request, cwd, data.loading, data.files])

  // Opening the screen on a worktree with changes: show the first one.
  useEffect(() => {
    if (selected === null && !data.loading && !request && data.files.length > 0) {
      setSelected(data.files[0].path)
      setScope('changed')
    }
  }, [selected, data.loading, data.files, request])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPanel('files')
        setScope('all')
        // The filter may not be mounted yet if the search was showing.
        setTimeout(() => { filter.current?.focus(); filter.current?.select() })
      }
      if (e.metaKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setPanel('search')
        setTimeout(() => { searchInput.current?.focus(); searchInput.current?.select() })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A comparison that cannot be made (the branch is gone) must not leave the screen without a base.
  useEffect(() => {
    if (pickedBase !== undefined && data.error?.includes(UNKNOWN_BASE)) {
      setBaseNotice(`La branche « ${pickedBase} » est introuvable : retour à la branche par défaut.`)
      setPickedBase(undefined)
    }
  }, [pickedBase, data.error])

  const totals = useMemo(() => ({
    added: data.files.reduce((n, f) => n + f.added, 0),
    deleted: data.files.reduce((n, f) => n + f.deleted, 0)
  }), [data.files])
  const changedPaths = useMemo(() => data.files.map((f) => f.path), [data.files])
  const change = data.files.find((f) => f.path === selected)
  const branchOptions = useMemo(() => {
    const names = new Set(data.branches)
    if (data.base) names.add(data.base.ref)
    return [...names].sort()
  }, [data.branches, data.base])

  return (
    <div className="code-screen">
      <div className="code-top">
        <span className="mono">{props.branch}</span>
        <span className="muted">comparé à</span>
        <select aria-label="Branche de comparaison" className="ctl-select mono" value={pickedBase ?? data.base?.ref ?? ''}
          disabled={!data.base} onChange={(e) => { setBaseNotice(null); setPickedBase(e.target.value) }}>
          {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <span className="mono totals" data-testid="code-totals">
          <span className="add">+{totals.added}</span> <span className="del">−{totals.deleted}</span>
          <span className="muted"> · {data.files.length} fichier{data.files.length > 1 ? 's' : ''} modifié{data.files.length > 1 ? 's' : ''} · {data.tree.length} dans le repo</span>
        </span>
      </div>
      {data.error && (
        <div className="code-warning" role="alert" data-testid="code-error">
          {data.base ? 'Données périmées, la dernière lecture a échoué' : 'Lecture impossible'} : {data.error}
        </div>
      )}
      {baseNotice && <div className="code-warning" role="alert" data-testid="base-notice">{baseNotice}</div>}
      {data.branchesError && (
        <div className="code-warning" role="alert" data-testid="branches-error">Liste des branches indisponible : {data.branchesError}</div>
      )}
      {data.watchError && (
        <div className="code-warning" role="alert" data-testid="watch-error">
          Le rafraîchissement automatique s'est arrêté ({data.watchError}) : la liste se met à jour toutes les 10 s.
        </div>
      )}
      <div className="code-main">
        <nav className="code-tree" aria-label="Fichiers">
          {panel === 'search' ? (
            <SearchPanel cwd={cwd} inputRef={searchInput} onClose={() => setPanel('files')}
              onOpen={(path, line) => useApp.getState().openInCode(cwd, path, 'code', line)} />
          ) : (<>
          <div role="group" aria-label="Fichiers affichés" className="seg">
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Tout le repo</button>
            <button type="button" aria-pressed={scope === 'changed'} data-testid="scope-changed" onClick={() => setScope('changed')}>
              Modifiés · {data.files.length}
            </button>
          </div>
          <input ref={filter} aria-label="Filtrer les fichiers" placeholder="Aller au fichier… ⌘P" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }} />
          <button type="button" className="link-btn" onClick={() => { setPanel('search'); setTimeout(() => searchInput.current?.focus()) }}>
            Rechercher dans le projet <span className="kbd">⇧⌘F</span>
          </button>
          <FileTree paths={scope === 'all' ? data.tree : changedPaths} changed={data.files} selected={selected} query={query} onSelect={select} />
          </>)}
        </nav>
        {selected !== null && data.base ? (
          <CodeView key={`${cwd}\0${selected}`} cwd={cwd} base={data.base} path={selected} change={change} mode={mode} onMode={setMode}
            tick={data.tick} onSaved={data.refresh} reveal={reveal} />
        ) : (
          <div className="code-view"><div className="code-message">{data.loading ? 'Chargement…' : 'Choisis un fichier.'}</div></div>
        )}
      </div>
    </div>
  )
}
