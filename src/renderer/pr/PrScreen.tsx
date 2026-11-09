import type { PrDetail, PrState } from '../../shared/pr'
import { Conversation } from './Conversation'
import { ChecksTab, CommitsTab, FilesTab } from './PrTabs'
import { tabCounts } from './mergeModel'
import { act, setSubTab, usePr, type PrSubTab } from './prStore'
import './pr.css'

const STATE_LABEL: Record<PrState, string> = { open: 'Ouverte', draft: 'Brouillon', merged: 'Mergée', closed: 'Fermée' }

function MergeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4" />
    </svg>
  )
}

function ExternalIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  )
}

function PrHeader({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const live = pr.state === 'open' || pr.state === 'draft'
  const n = pr.commits.length
  return (
    <div className="pr-title-row">
      <div className="pr-title">
        <h1>{pr.title} <span className="pr-number">#{pr.number}</span></h1>
        <div className="pr-context">
          <span className="pr-state" data-state={pr.state} data-testid="pr-state"><MergeIcon />{STATE_LABEL[pr.state]}</span>
          <span><span className="pr-author">{pr.author.login}</span> veut merger {n} commit{n > 1 ? 's' : ''} dans</span>
          <span className="pr-ref mono">{pr.base}</span>
          <span>depuis</span>
          <span className="pr-ref mono">{pr.head}</span>
          <span className="mono"><span className="pr-add">+{pr.additions}</span> <span className="pr-del">−{pr.deletions}</span></span>
        </div>
      </div>
      <div className="pr-actions">
        {live && (
          <button disabled={busy !== null} onClick={() => void act({ type: 'draft', draft: pr.state === 'open' })}>
            {pr.state === 'draft' ? 'Prête pour review' : 'Repasser en brouillon'}
          </button>
        )}
        {live && <button className="pr-danger" disabled={busy !== null} onClick={() => void act({ type: 'close' })}>Fermer la PR</button>}
        {pr.state === 'closed' && <button disabled={busy !== null} onClick={() => void act({ type: 'reopen' })}>Rouvrir la PR</button>}
        <button onClick={() => void window.canopy.openExternal(pr.url)}>Ouvrir sur GitHub <ExternalIcon /></button>
      </div>
    </div>
  )
}

function SubTabs({ pr }: { pr: PrDetail }): React.JSX.Element {
  const subTab = usePr((s) => s.subTab)
  const c = tabCounts(pr)
  const tabs: { id: PrSubTab; label: string; count: string; alert: boolean }[] = [
    { id: 'conv', label: 'Conversation', count: String(c.openThreads), alert: c.alert.conv },
    { id: 'commits', label: 'Commits', count: String(c.commits), alert: false },
    { id: 'checks', label: 'Checks', count: `${c.checks.ok}/${c.checks.total}`, alert: c.alert.checks },
    { id: 'files', label: 'Fichiers', count: String(c.files), alert: false }
  ]
  return (
    <div className="pr-tabs" role="tablist" aria-label="Sections de la PR">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={subTab === t.id} onClick={() => setSubTab(t.id)}>
          {t.label} <span className="pr-tab-count" data-alert={t.alert ? 'true' : undefined}>{t.count}</span>
        </button>
      ))}
    </div>
  )
}

/** The « PR » view: the PR of the selected worktree's branch. */
export function PrScreen(): React.JSX.Element {
  const detail = usePr((s) => s.detail)
  const error = usePr((s) => s.error)
  const subTab = usePr((s) => s.subTab)
  return (
    <div className="pr-screen">
      {error && <div className="pr-error" role="alert" data-testid="pr-error">{error}</div>}
      {detail
        ? (
          <>
            <div className="pr-head" data-testid="pr-header">
              <PrHeader pr={detail} />
              <SubTabs pr={detail} />
            </div>
            <section className="pr-body" aria-label="Contenu de la PR" data-tab={subTab}>
              {subTab === 'conv' && <Conversation pr={detail} />}
              {subTab === 'commits' && <CommitsTab pr={detail} />}
              {subTab === 'checks' && <ChecksTab pr={detail} />}
              {subTab === 'files' && <FilesTab pr={detail} />}
            </section>
          </>
        )
        : !error && <div className="placeholder">Chargement de la PR…</div>}
    </div>
  )
}
