import { useEffect, useRef, useState } from 'react'
import { basename, useApp } from '../store'
import { openRepoFlow, selectRepoFlow } from './repoActions'

const folderIcon = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A0A7B2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

const chevron = (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A0A7B2" strokeWidth="2">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const REFRESH_MS = 10_000

/** The recent repos with a session waiting for an answer, displayed or not. Refreshed as sessions change state. */
function useAttention(repo: string | null): Set<string> {
  const [waiting, setWaiting] = useState<Set<string>>(new Set())
  useEffect(() => {
    let live = true
    const read = (): void => {
      void (async () => {
        const recents = await window.canopy.recentRepos().catch((): string[] => [])
        const all = [...new Set([...(repo ? [repo] : []), ...recents])]
        const flags = await Promise.all(all.map((r) => window.canopy.repoNeedsAttention(r).catch(() => false)))
        if (live) setWaiting(new Set(all.filter((_, i) => flags[i])))
      })()
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    const off = window.canopy.on('session:state', read)
    const off2 = window.canopy.on('session:permission', read)
    return () => { live = false; clearInterval(timer); off(); off2() }
  }, [repo])
  return waiting
}

export function RepoPicker(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const waiting = useAttention(repo)
  const otherWaiting = [...waiting].some((r) => r !== repo)

  useEffect(() => {
    if (!open) return
    void window.canopy.recentRepos().then(setRecents, () => setRecents([]))
    const close = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div className="repo-picker" ref={root}>
      <button className="ctl" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {folderIcon}
        {repo ? (
          <>
            <span className="name">{basename(repo)}</span>
            <span className="path" title={repo}>{repo}</span>
          </>
        ) : (
          <span>Aucun dépôt</span>
        )}
        {otherWaiting && <span className="badge" role="img" aria-label="Une session attend ta réponse dans un autre dépôt" data-testid="repo-attention" />}
        {chevron}
      </button>
      {open && (
        <div className="menu" role="menu">
          {recents.map((r) => (
            <button key={r} role="menuitem" onClick={() => { setOpen(false); void selectRepoFlow(r) }}>
              <span>{basename(r)}</span>
              {waiting.has(r) && <span className="badge" role="img" aria-label="Une session attend ta réponse" />}
              <span className="muted" title={r}>{r}</span>
            </button>
          ))}
          {recents.length > 0 && <div className="sep" />}
          <button role="menuitem" onClick={() => { setOpen(false); void openRepoFlow() }}>
            Ouvrir un dépôt…
          </button>
        </div>
      )}
    </div>
  )
}
