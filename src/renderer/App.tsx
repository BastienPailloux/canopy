import { useEffect, useState } from 'react'
import { CodeScreen } from './code/CodeScreen'
import { SessionsView } from './sessions/SessionsView'
import { connectSessions } from './sessions/sessionStore'
import { TrustDialog } from './sessions/TrustDialog'
import { connectTerminals } from './terminal/terminalStore'
import { CommandBar } from './shell/CommandBar'
import { Header } from './shell/Header'
import { WorktreeList } from './shell/WorktreeList'
import { openRepoFlow, selectRepoFlow } from './shell/repoActions'
import { basename, useApp, worktreeLabel } from './store'

function Empty(): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="empty">
      <h2>Aucun dépôt ouvert</h2>
      <span>Choisis un dépôt git pour voir ses worktrees.</span>
      <button className="primary" onClick={() => void openRepoFlow().then(setError)}>Ouvrir un dépôt</button>
      {error && <span role="alert" style={{ color: 'var(--del)' }}>{error}</span>}
    </div>
  )
}

function Main(): React.JSX.Element {
  const view = useApp((s) => s.view)
  const worktree = useApp((s) => s.worktrees.find((w) => w.path === s.worktree))
  if (!worktree) return <div className="placeholder">Aucun worktree sélectionné.</div>
  return (
    <>
      <div className="main-head">
        <h1 data-testid="active-worktree">{worktreeLabel(worktree)}</h1>
        <span className="sub mono" title={worktree.path}>{basename(worktree.path)}</span>
      </div>
      {view === 'sessions'
        ? <SessionsView cwd={worktree.path} worktreeLabel={worktreeLabel(worktree)} />
        : <CodeScreen key={worktree.path} cwd={worktree.path} branch={worktreeLabel(worktree)} />}
    </>
  )
}

export function App(): React.JSX.Element {
  const repo = useApp((s) => s.repo)

  useEffect(() => connectSessions(), [])
  useEffect(() => connectTerminals(), [])

  // Re-open the most recent repo that still exists.
  useEffect(() => {
    let live = true
    void (async () => {
      const recents = await window.canopy.recentRepos().catch(() => [])
      for (const r of recents) {
        if (!live || useApp.getState().repo) return
        if (await selectRepoFlow(r)) return
      }
    })()
    return () => { live = false }
  }, [])

  return (
    <div className="app">
      <TrustDialog />
      <CommandBar />
      <Header />
      <div className="body">
        {repo ? (
          <>
            <aside className="sidebar" aria-label="Worktrees">
              <WorktreeList key={repo} repo={repo} />
            </aside>
            <main className="main"><Main /></main>
          </>
        ) : (
          <main className="main"><Empty /></main>
        )}
      </div>
    </div>
  )
}
