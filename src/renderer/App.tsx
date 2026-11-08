import { useEffect, useRef } from 'react'
import type { Workspace } from '../shared/types'
import type { Stash } from '../shared/update'
import { CodeScreen } from './code/CodeScreen'
import { SessionsView } from './sessions/SessionsView'
import { closeActiveTabIfSafe, connectSessions } from './sessions/sessionStore'
import { SidePanel } from './sessions/SidePanel'
import { TrustDialog } from './sessions/TrustDialog'
import { connectTerminals } from './terminal/terminalStore'
import { AccountFooter } from './shell/AccountFooter'
import { CommandBar } from './shell/CommandBar'
import { Header } from './shell/Header'
import { useLayout } from './shell/layoutStore'
import { dragLeft, dragRight, LEFT_DEFAULT, RAIL_WIDTH, RIGHT_DEFAULT, stepLeft } from './shell/panelWidths'
import { Resizer } from './shell/Resizer'
import { WorktreeList } from './shell/WorktreeList'
import { connectLastEntry, openFromTerminal, openRepoFlow, selectRepoFlow } from './shell/repoActions'
import { basename, useApp, worktreeLabel } from './store'
import { connectTickets } from './tickets/ticketStore'
import { connectLinear } from './tickets/linearStore'
import { parseTicketKey, type TicketKey } from '../shared/tickets'
import { TicketEditor } from './tickets/TicketEditor'
import { TicketsScreen } from './tickets/TicketsScreen'
import { connectUnsaved } from './unsaved'
import { connectUpdateStash, restoreStash } from './update/stash'
import { UpdateBanner } from './update/UpdateBanner'
import { RestoredChip, WhatsNew } from './update/WhatsNew'

/** What the terminal asked for at launch, read once per page load. */
let launchFolder: Promise<string | null> | undefined
let launchStash: Promise<Stash | null> | undefined
let restored = false

function Empty(): React.JSX.Element {
  const error = useApp((s) => s.openError)
  return (
    <div className="empty">
      <h2>Aucun dépôt ouvert</h2>
      <span>Choisis un dépôt git pour voir ses worktrees.</span>
      <button className="primary" onClick={() => void openRepoFlow()}>Ouvrir un dépôt</button>
      {error && <span role="alert" style={{ color: 'var(--del)' }}>{error}</span>}
    </div>
  )
}

/** The worktree list, as wide as dragged, or a rail of initials once dragged too narrow. */
function Sidebar({ repo, workspace }: { repo: string; workspace: Workspace }): React.JSX.Element {
  const left = useLayout((s) => s.left)
  const rail = useLayout((s) => s.rail)
  const update = useLayout((s) => s.update)
  const from = useRef(0)
  const shown = rail ? RAIL_WIDTH : left
  const apply = (r: { width: number; rail: boolean }): void => update({ left: r.width, rail: r.rail })
  return (
    <>
      <aside className="sidebar" aria-label="Worktrees" data-rail={rail ? 'true' : undefined} style={{ width: shown }}>
        <WorktreeList key={workspace.root} repo={repo} workspace={workspace} rail={rail} />
        <AccountFooter />
      </aside>
      <Resizer label="Largeur des worktrees" value={shown}
        onDragStart={() => { from.current = shown }}
        onDrag={(dx) => apply(dragLeft(from.current + dx, useLayout.getState().left))}
        onStep={(dx) => apply(stepLeft(useLayout.getState(), dx))}
        onReset={() => update({ left: LEFT_DEFAULT, rail: false })} />
    </>
  )
}

/** The edge of the Sessions side panel: dragged left, the panel grows. */
function SidePanelEdge(): React.JSX.Element {
  const right = useLayout((s) => s.right)
  const update = useLayout((s) => s.update)
  const from = useRef(0)
  return (
    <Resizer label="Largeur du panneau latéral" value={right}
      onDragStart={() => { from.current = dragRight(useLayout.getState().right, 0, window.innerWidth) }}
      onDrag={(dx) => update({ right: dragRight(from.current, -dx, window.innerWidth) })}
      onStep={(dx) => update({ right: dragRight(useLayout.getState().right, -dx, window.innerWidth) })}
      onReset={() => update({ right: RIGHT_DEFAULT })} />
  )
}

function Main(): React.JSX.Element {
  const view = useApp((s) => s.view)
  const worktree = useApp((s) => s.worktrees.find((w) => w.path === s.worktree))
  const orphan = useApp((s) => s.orphans.find((w) => w.path === s.worktree))
  const shown = worktree ?? orphan
  if (!shown) return <div className="placeholder">Aucun worktree sélectionné.</div>
  return (
    <>
      <div className="main-head">
        <h1 data-testid="active-worktree">{worktreeLabel(shown)}</h1>
        <span className="sub mono" title={shown.path}>{basename(shown.path)}</span>
      </div>
      {view === 'sessions'
        ? (
          <div className="main-row">
            <SessionsView cwd={shown.path} worktreeLabel={worktreeLabel(shown)} />
            {worktree && <SidePanelEdge />}
            {worktree && <SidePanel cwd={worktree.path} branch={worktreeLabel(worktree)} />}
          </div>
        )
        : worktree
          ? <CodeScreen key={worktree.path} cwd={worktree.path} branch={worktreeLabel(worktree)} />
          : <div className="placeholder">Ce worktree n'existe plus sur le disque : il n'y a plus de code à montrer.</div>}
    </>
  )
}

/** The editor of the open ticket; Linear tickets have none yet. */
function OpenTicket({ k }: { k: TicketKey | 'new' }): React.JSX.Element {
  if (k === 'new') return <TicketEditor id="new" />
  const p = parseTicketKey(k)
  if (p?.source === 'local') return <TicketEditor id={p.id} />
  return (
    <div className="placeholder">
      <p>Ticket Linear — éditeur à venir</p>
      <button className="link" onClick={() => useApp.getState().setOpenTicket(null)}>Retour à la liste</button>
    </div>
  )
}

export function App(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const workspace = useApp((s) => s.workspace)
  const view = useApp((s) => s.view)
  const openTicket = useApp((s) => s.openTicket)

  useEffect(() => connectSessions(), [])
  useEffect(() => connectTerminals(), [])
  useEffect(() => connectUnsaved(), [])
  useEffect(() => connectUpdateStash(), [])
  useEffect(() => connectLastEntry(), [])
  useEffect(() => connectTickets(), [])
  useEffect(() => connectLinear(), [])
  useEffect(() => window.canopy.on('menu:closeTab', () => {
    const { view, worktree } = useApp.getState()
    // A dialog is the thing in front: ⌘W must not act behind it.
    if (view === 'sessions' && worktree && !document.querySelector('[aria-modal="true"]')) closeActiveTabIfSafe(worktree)
  }), [])

  // A folder asked for from the terminal while the app runs. Listens before the launch effect takes what waited.
  useEffect(() => window.canopy.on('app:openFolder', (path) => {
    if (typeof path === 'string') void openFromTerminal(path)
  }), [])

  // A folder asked for from the terminal wins; else re-open the most recent folder that still exists, on the entry left selected.
  useEffect(() => {
    let live = true
    void (async () => {
      // Work set aside by an update comes back before any folder opens, and a failed read must not stop the launch.
      launchStash ??= window.canopy.takeStash().catch(() => null)
      const stash = await launchStash
      if (stash && !restored) {
        restored = true
        try { restoreStash(stash) } catch (e) { console.error('Restauration impossible', e) }
      }
      launchFolder ??= window.canopy.takeOpenFolder().catch(() => null)
      const asked = await launchFolder
      // The page is told once: a second run of this effect (StrictMode) finds the same answer.
      if (asked && (await openFromTerminal(asked))) return
      const recents = await window.canopy.recentRepos().catch(() => [])
      for (const r of recents) {
        if (!live || useApp.getState().repo) return
        if (await selectRepoFlow(r, true)) return
      }
    })()
    return () => { live = false }
  }, [])

  return (
    <div className="app">
      <TrustDialog />
      <CommandBar />
      <UpdateBanner />
      <RestoredChip />
      <WhatsNew />
      <Header />
      <div className="body">
        {repo && workspace && view === 'tickets' ? (
          <main className="main tickets-view">{openTicket ? <OpenTicket k={openTicket} /> : <TicketsScreen />}</main>
        ) : repo && workspace ? (
          <>
            <Sidebar repo={repo} workspace={workspace} />
            <main className="main"><Main /></main>
          </>
        ) : (
          <main className="main"><Empty /></main>
        )}
      </div>
    </div>
  )
}
