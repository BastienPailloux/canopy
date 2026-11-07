import { Fragment, useMemo, useState } from 'react'
import type { OrphanedWorktree } from '../../shared/api'
import { MAX_WORKSPACE_REPOS, type Workspace, type WorkspaceEntry, type Worktree, type WorktreeStatus } from '../../shared/types'
import { basename, useApp, worktreeLabel } from '../store'
import { NewWorktreeDialog } from './NewWorktreeDialog'
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog'
import { STATUS_LABEL, useStatuses } from './useStatuses'
import { forget, useWorktrees, type StatsEntry } from './useWorktrees'
import { entryLabel, groupEntries, isSingleRepo } from './workspaceList'

const plusIcon = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const trashIcon = (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
)

function Row(props: { w: Worktree; label: string; idleMain: string; entry?: StatsEntry; ports?: Record<string, number>; status: WorktreeStatus; active: boolean; onPick: () => void; onRemove: () => void }): React.JSX.Element {
  const { w, entry } = props
  const stats = entry?.stats
  return (
    <div className="wt-row">
      <button className="wt" aria-current={props.active} onClick={props.onPick} data-testid="worktree" data-path={w.path}>
        <span className="dot" data-status={props.status} aria-hidden="true" />
        <span className="col">
          <span className="name" title={props.label}>{props.label}</span>
          <span className="status" data-status={props.status} data-testid="worktree-status">{w.isMain && props.status === 'idle' ? props.idleMain : STATUS_LABEL[props.status]}</span>
          <span className="numbers">
            {stats && stats.added > 0 && <span className="add">+{stats.added}</span>}
            {stats && stats.deleted > 0 && <span className="del">−{stats.deleted}</span>}
            {stats && (
              <span className="ahead">{stats.ahead === 0 ? 'à jour' : `${stats.ahead} commit${stats.ahead > 1 ? 's' : ''}`}</span>
            )}
            {Object.entries(props.ports ?? {}).map(([service, port]) => (
              <span key={service} className="port mono" title={`${service} : localhost:${port}`} data-testid="worktree-port">:{port}</span>
            ))}
            {entry?.error !== undefined && (
              <span className="warn" title={entry.error} data-testid="worktree-error">
                {stats ? 'données périmées' : 'état illisible'}
              </span>
            )}
          </span>
        </span>
      </button>
      {!w.isMain && (
        <button className="wt-remove" aria-label={`Supprimer ${props.label}`} onClick={props.onRemove}>
          {trashIcon}
        </button>
      )}
    </div>
  )
}

const count = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

function liveText(w: OrphanedWorktree): string {
  return [
    ...(w.sessions > 0 ? [count(w.sessions, 'session', 'sessions')] : []),
    ...(w.terminals > 0 ? [count(w.terminals, 'terminal', 'terminaux')] : [])
  ].join(', ')
}

/** Deleted from outside while something runs there: reachable until that ends, closed from its tabs. */
function Orphans(props: { active: string | null; single: boolean }): React.JSX.Element | null {
  const orphans = useApp((s) => s.orphans)
  const selectOrphan = useApp((s) => s.selectOrphan)
  if (orphans.length === 0) return null
  const label = (w: OrphanedWorktree): string => (props.single ? worktreeLabel(w) : `${basename(w.repo)} · ${worktreeLabel(w)}`)
  return (
    <>
      <p className="list-error" role="alert" data-testid="orphan-notice">
        {orphans.map((w) => `« ${label(w)} » a disparu du disque : ${liveText(w)} encore actif${w.sessions + w.terminals > 1 ? 's' : ''}.`).join(' ')}
      </p>
      {orphans.map((w) => (
        <div key={w.path} className="wt-row">
          <button className="wt" aria-current={w.path === props.active} onClick={() => selectOrphan(w)} data-testid="worktree-orphan" data-path={w.path}>
            <span className="dot" data-status="waiting" aria-hidden="true" />
            <span className="col">
              <span className="name" title={w.path}>{label(w)}</span>
              <span className="status">Dossier disparu · {liveText(w)}</span>
            </span>
          </button>
        </div>
      ))}
    </>
  )
}

export function WorktreeList({ repo, workspace }: { repo: string; workspace: Workspace }): React.JSX.Element {
  const active = useApp((s) => s.worktree)
  const openError = useApp((s) => s.openError)
  const setWorktree = useApp((s) => s.setWorktree)
  const selectEntry = useApp((s) => s.selectEntry)
  const { entries, ports, listError, sync } = useWorktrees(repo, workspace.root)
  const statuses = useStatuses()
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<WorkspaceEntry | null>(null)
  const sections = useMemo(() => groupEntries(workspace), [workspace])
  const single = isSingleRepo(workspace)

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Worktrees · {workspace.entries.length}</span>
        <button className="icon-btn" aria-label="Nouveau worktree" onClick={() => setCreating(true)}>{plusIcon}</button>
      </div>
      {openError && <p className="list-error" role="alert">{openError}</p>}
      {listError && <p className="list-error" role="alert">Liste indisponible : {listError}</p>}
      {workspace.truncated && (
        <p className="list-notice" role="status" data-testid="workspace-truncated">Trop de repos dans ce dossier : seuls les {MAX_WORKSPACE_REPOS} premiers sont listés.</p>
      )}
      {workspace.failed.length > 0 && (
        <p className="list-notice" role="status" data-testid="workspace-failed" title={workspace.failed.join('\n')}>
          Lecture impossible de {workspace.failed.map(basename).join(', ')} : dernières données conservées.
        </p>
      )}
      <div className="wt-list">
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.title !== null && <h3 className="wt-section" title={section.title} data-testid="worktree-section-title">{section.title}</h3>}
            {section.entries.map((e) => {
              const { path } = e.worktree
              return (
                <Row key={path} w={e.worktree} label={entryLabel(e, single)} idleMain={single ? 'Principal' : worktreeLabel(e.worktree)}
                  entry={entries[path]} ports={ports[path]} status={statuses[path] ?? 'idle'} active={path === active}
                  onPick={() => selectEntry(e)} onRemove={() => setRemoving(e)} />
              )
            })}
          </Fragment>
        ))}
        <Orphans active={active} single={single} />
      </div>
      {creating && (
        <NewWorktreeDialog repo={repo} onClose={() => setCreating(false)}
          onCreated={(path) => {
            setCreating(false)
            void sync().then(() => setWorktree(path))
          }} />
      )}
      {removing && (
        <RemoveWorktreeDialog repo={removing.repo} worktree={removing.worktree} onClose={() => setRemoving(null)}
          onRemoved={() => { forget(removing.worktree.path); setRemoving(null); void sync() }} />
      )}
    </>
  )
}
