import { useEffect, useRef, useState } from 'react'
import { basename, useApp } from '../store'
import { debounce, poll, POLL_HEALTHY_MS } from './polling'
import { openRepoFlow, selectRepoFlow } from './repoActions'
import { workspaceRepos } from './workspaceList'

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

/** State changes come in bursts, and each read asks about every recent repo. */
const ATTENTION_DEBOUNCE_MS = 300

interface Attention {
  /** The recent folders with a session waiting for an answer, displayed or not. */
  waiting: Set<string>
  /** One waits somewhere else than in the active repo. */
  elsewhere: boolean
}

/**
 * Who waits for an answer, refreshed as sessions change state. Each repo of the workspace is asked alone, a recent
 * folder for all its repos: the opened folder, the parent repo included, would answer for the active repo too.
 */
function useAttention(repo: string | null, folder: string | null, repos: string): Attention {
  const [attention, setAttention] = useState<Attention>({ waiting: new Set(), elsewhere: false })
  useEffect(() => {
    let live = true
    const own = repos === '' ? [] : repos.split('\0')
    const ask = (path: string, alone?: boolean): Promise<boolean> => window.canopy.repoNeedsAttention(path, alone).catch(() => false)
    const read = (): void => {
      void (async () => {
        const recents = await window.canopy.recentRepos().catch((): string[] => [])
        const [ownFlags, recentFlags] = await Promise.all([Promise.all(own.map((r) => ask(r, true))), Promise.all(recents.map((r) => ask(r)))])
        if (!live) return
        const waiting = recents.filter((_, i) => recentFlags[i])
        setAttention({
          waiting: new Set(waiting),
          elsewhere: own.some((r, i) => r !== repo && ownFlags[i]) || waiting.some((r) => r !== repo && r !== folder)
        })
      })()
    }
    read()
    const soon = debounce(read, ATTENTION_DEBOUNCE_MS)
    const stopPolling = poll(read, POLL_HEALTHY_MS)
    const off = window.canopy.on('session:state', soon.call)
    const off2 = window.canopy.on('session:permission', soon.call)
    window.addEventListener('focus', soon.call)
    return () => {
      live = false
      soon.cancel()
      stopPolling()
      off()
      off2()
      window.removeEventListener('focus', soon.call)
    }
  }, [repo, folder, repos])
  return attention
}

export function RepoPicker(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  // What was opened: recents and this button speak of folders, the list of the repos inside.
  const folder = useApp((s) => (s.repo ? s.workspace?.root ?? s.repo : null))
  const repos = useApp((s) => (s.workspace ? workspaceRepos(s.workspace).join('\0') : ''))
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const { waiting, elsewhere } = useAttention(repo, folder, repos)

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
        {folder ? (
          <>
            <span className="name">{basename(folder)}</span>
            <span className="path" title={folder}>{folder}</span>
          </>
        ) : (
          <span>Aucun dépôt</span>
        )}
        {elsewhere && <span className="badge" role="img" aria-label="Une session attend ta réponse dans un autre dépôt" data-testid="repo-attention" />}
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
