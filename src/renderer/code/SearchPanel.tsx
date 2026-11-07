import { useEffect, useMemo, useRef, useState } from 'react'
import { preview } from '../../shared/preview'
import { DEFAULT_SEARCH_LIMIT, type Location, type SearchHit } from '../../shared/types'

const DEBOUNCE_MS = 200

/** What was typed, per worktree: it outlives a visit to Sessions. */
interface Typed { query: string; regex: boolean; caseSensitive: boolean }
const typed = new Map<string, Typed>()

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

function group<T extends Location>(hits: T[]): { path: string; hits: T[] }[] {
  const byPath = new Map<string, T[]>()
  for (const h of hits) byPath.set(h.path, [...(byPath.get(h.path) ?? []), h])
  return [...byPath].map(([path, list]) => ({ path, hits: list }))
}

/** Hits by file: a click opens one. External ones cannot be opened: a click only says where they are. */
function HitList(props: { hits: Location[]; onOpen: (hit: Location) => void }): React.JSX.Element {
  const groups = useMemo(() => group(props.hits), [props.hits])
  return <>{groups.map((g) => (
    <div key={g.path} className="search-file">
      <div className="search-path mono" title={g.path}>{g.path}<span className="muted"> · {g.hits.length}</span></div>
      {g.hits.map((h) => (
        <button key={`${h.line}:${h.column}`} type="button" className="search-hit" data-testid="search-hit" onClick={() => props.onOpen(h)}>
          <span className="line mono">{h.line}</span>
          <span className="text mono">{h.external ? 'hors du worktree' : preview(h.text ?? '')}</span>
        </button>
      ))}
    </div>
  ))}</>
}

/** What a definition or a list of uses found. Null `hits`: still looking. */
export interface Found { title: string; hits: Location[] | null }

/** The answer of the language server, in the panel of the search and with its list. */
export function ResultsPanel(props: { found: Found; onOpen: (hit: Location) => void; onClose: () => void }): React.JSX.Element {
  const { title, hits } = props.found
  return (
    <div className="search-panel" data-testid="results-panel">
      <div className="search-head">
        <button type="button" className="link-btn" onClick={props.onClose}>← Fichiers</button>
      </div>
      <h2 className="results-title">{title}</h2>
      <div className="search-results" data-testid="search-results">
        {hits === null && <p className="tree-empty">Recherche…</p>}
        {hits?.length === 0 && <p className="tree-empty">Aucun résultat.</p>}
        {hits?.some((h) => h.fallback) && <p className="tree-empty" data-testid="results-fallback">Recherche par texte : le serveur de langage n'a pas répondu ou ne lit pas ce fichier.</p>}
        {hits && <HitList hits={hits} onOpen={props.onOpen} />}
      </div>
    </div>
  )
}

export function SearchPanel(props: {
  cwd: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onOpen: (path: string, line: number) => void
  onClose: () => void
}): React.JSX.Element {
  const { cwd } = props
  const [initial] = useState<Typed>(() => typed.get(cwd) ?? { query: '', regex: false, caseSensitive: false })
  const [query, setQuery] = useState(initial.query)
  const [regex, setRegex] = useState(initial.regex)
  const [caseSensitive, setCaseSensitive] = useState(initial.caseSensitive)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const run = useRef(0)

  useEffect(() => { typed.set(cwd, { query, regex, caseSensitive }) }, [cwd, query, regex, caseSensitive])

  useEffect(() => {
    const id = ++run.current
    if (query === '') {
      setHits(null)
      setError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      window.canopy.searchText(cwd, query, { channel: 'panel', regex, caseSensitive, limit: DEFAULT_SEARCH_LIMIT }).then(
        (found) => {
          if (run.current !== id) return
          setSearching(false)
          if (found === null) return
          setHits(found)
          setError(null)
        },
        (e: unknown) => {
          if (run.current !== id) return
          setSearching(false)
          setHits(null)
          setError(errorText(e))
        }
      )
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [cwd, query, regex, caseSensitive])

  return (
    <div className="search-panel" role="search" data-testid="search-panel">
      <div className="search-head">
        <button type="button" className="link-btn" onClick={props.onClose}>← Fichiers</button>
      </div>
      <div className="search-field">
        <input ref={props.inputRef} aria-label="Rechercher dans le projet" placeholder="Rechercher… ⇧⌘F" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') props.onClose() }} />
        <button type="button" className="opt mono" aria-pressed={caseSensitive} title="Respecter la casse" aria-label="Respecter la casse"
          onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
        <button type="button" className="opt mono" aria-pressed={regex} title="Expression régulière" aria-label="Expression régulière"
          onClick={() => setRegex(!regex)}>.*</button>
      </div>
      <div className="search-results" data-testid="search-results">
        {error && <p className="tree-empty" role="alert" data-testid="search-error">{error}</p>}
        {!error && hits !== null && hits.length === 0 && !searching && <p className="tree-empty">Aucun résultat.</p>}
        {!error && hits !== null && hits.length >= DEFAULT_SEARCH_LIMIT && (
          <p className="tree-empty">{DEFAULT_SEARCH_LIMIT} premiers résultats : précise la recherche.</p>
        )}
        {!error && hits && <HitList hits={hits} onOpen={(h) => props.onOpen(h.path, h.line)} />}
      </div>
    </div>
  )
}
