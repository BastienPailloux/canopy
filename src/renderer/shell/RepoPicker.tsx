import { useEffect, useRef, useState } from 'react'
import { basename, useApp } from '../store'
import { debounce, poll, POLL_HEALTHY_MS } from './polling'
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

/** State changes come in bursts, and each read asks about every recent repo. */
const ATTENTION_DEBOUNCE_MS = 300

interface RepoFlags {
  /** The recent folders flagged, displayed or not. */
  set: Set<string>
  /** Some folder other than the active repo is flagged. */
  elsewhere: boolean
}

/**
 * Which recent folders `ask` flags, refreshed on `events`, on focus and by polling.
 * A folder answers for its repos, without the active one when asked for "elsewhere".
 * `ask` and `events` must be stable (module-level).
 */
function useRepoFlags(ask: (path: string, except?: string) => Promise<boolean>, events: string[], repo: string | null, folder: string | null): RepoFlags {
  const [flags, setFlags] = useState<RepoFlags>({ set: new Set(), elsewhere: false })
  useEffect(() => {
    let live = true
    const read = (): void => {
      void (async () => {
        const recents = await window.canopy.recentRepos().catch((): string[] => [])
        const folders = [...new Set([...(folder ? [folder] : []), ...recents])]
        const [recentFlags, elsewhereFlags] = await Promise.all([
          Promise.all(recents.map((r) => ask(r))),
          Promise.all(folders.map((f) => ask(f, repo ?? undefined)))
        ])
        if (live) setFlags({ set: new Set(recents.filter((_, i) => recentFlags[i])), elsewhere: elsewhereFlags.some(Boolean) })
      })()
    }
    read()
    const soon = debounce(read, ATTENTION_DEBOUNCE_MS)
    const stopPolling = poll(read, POLL_HEALTHY_MS)
    const offs = events.map((e) => window.canopy.on(e, soon.call))
    window.addEventListener('focus', soon.call)
    return () => {
      live = false
      soon.cancel()
      stopPolling()
      offs.forEach((off) => off())
      window.removeEventListener('focus', soon.call)
    }
  }, [ask, events, repo, folder])
  return flags
}

/** A session waits for an answer. */
const needsAttention = (path: string, except?: string): Promise<boolean> => window.canopy.repoNeedsAttention(path, except).catch(() => false)
const SESSION_EVENTS = ['session:state', 'session:permission']
/** A critical dependency update; also refreshed when a report changes. */
const hasCriticalDeps = (path: string, except?: string): Promise<boolean> => window.canopy.depsCritical(path, except).then((n) => n > 0, () => false)
const DEPS_EVENTS = ['deps:changed']

function DepsAlertIcon({ label, testId }: { label: string; testId?: string }): React.JSX.Element {
  return (
    <svg role="img" aria-label={label} data-testid={testId} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--del)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export function RepoPicker(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  // What was opened: recents and this button speak of folders, the list of the repos inside.
  const folder = useApp((s) => (s.repo ? s.workspace?.root ?? s.repo : null))
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const { set: waiting, elsewhere } = useRepoFlags(needsAttention, SESSION_EVENTS, repo, folder)
  const { set: critical, elsewhere: depsElsewhere } = useRepoFlags(hasCriticalDeps, DEPS_EVENTS, repo, folder)

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
        {depsElsewhere && <DepsAlertIcon label="Dépendances critiques dans un autre dépôt" testId="repo-deps-alert" />}
        {chevron}
      </button>
      {open && (
        <div className="menu" role="menu">
          {recents.map((r) => (
            <button key={r} role="menuitem" onClick={() => { setOpen(false); void selectRepoFlow(r) }}>
              <span>{basename(r)}</span>
              {waiting.has(r) && <span className="badge" role="img" aria-label="Une session attend ta réponse" />}
              {critical.has(r) && <DepsAlertIcon label="Dépendances critiques à mettre à jour" testId="repo-deps-alert-item" />}
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
