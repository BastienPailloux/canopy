import { useState } from 'react'
import type { CheckOutcome, PrCheck, PrDetail } from '../../shared/pr'
import { useApp } from '../store'
import { ago, checksSummary, plural } from './mergeModel'
import { act, fixCheck, usePr } from './prStore'

const duration = (ms: number | null): string => {
  if (ms === null) return ''
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`
}

const MARK: Record<CheckOutcome, { glyph: string; label: string }> = {
  success: { glyph: '✓', label: 'Réussi' },
  failure: { glyph: '✕', label: 'Échec' },
  pending: { glyph: '…', label: 'En cours' },
  neutral: { glyph: '–', label: 'Neutre' }
}

function Mark({ outcome }: { outcome: CheckOutcome | null }): React.JSX.Element | null {
  if (!outcome) return null
  return <span className="pr-mark" data-outcome={outcome} role="img" aria-label={MARK[outcome].label}>{MARK[outcome].glyph}</span>
}

export function CommitsTab({ pr }: { pr: PrDetail }): React.JSX.Element {
  return (
    <div className="pr-card" data-testid="pr-commits">
      {pr.commits.map((c) => (
        <div key={c.oid} className="pr-list-row">
          <Mark outcome={c.outcome} />
          <span className="pr-list-main">{c.message.split('\n')[0]}</span>
          <span className="pr-muted">{c.author} · {ago(c.at)}</span>
          <span className="mono pr-muted">{c.oid.slice(0, 7)}</span>
        </div>
      ))}
      <More count={pr.truncated.commits} url={pr.url} />
    </div>
  )
}

function More({ count, url }: { count: number; url: string }): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <div className="pr-list-row">
      <button className="pr-btn pr-small" onClick={() => void window.canopy.openExternal(url)}>{count} de plus — ouvrir sur GitHub</button>
    </div>
  )
}

function CheckRow({ pr, check }: { pr: PrDetail; check: PrCheck }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const cwd = usePr((s) => s.cwd)
  const [log, setLog] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const expandable = check.outcome === 'failure' && check.run !== null
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && log === null && cwd && check.run) {
      setFailed(false)
      window.canopy.prFailedLog(cwd, check.run.runId, check.run.jobId).then(setLog).catch(() => setFailed(true))
    }
  }
  return (
    <div className="pr-check" data-outcome={check.outcome} data-testid="pr-check">
      <div className="pr-list-row">
        <Mark outcome={check.outcome} />
        {expandable
          ? <button className="pr-link pr-list-main" aria-expanded={open} onClick={toggle}>{check.name}</button>
          : <span className="pr-list-main">{check.name}</span>}
        <span className="pr-muted">{check.detail}{check.durationMs !== null ? ` · ${duration(check.durationMs)}` : ''}</span>
        {check.url && <button className="pr-btn pr-small" onClick={() => void window.canopy.openExternal(check.url!)}>Logs</button>}
        {check.run && (
          <button className="pr-btn pr-small" disabled={busy !== null} onClick={() => void act({ type: 'rerun', runId: check.run!.runId, jobId: check.run!.jobId })}>Relancer</button>
        )}
        {/* Another app's check has no log here: Claude gets its detail and link. */}
        {check.outcome === 'failure' && !check.run && (
          <button className="pr-btn pr-claude pr-small" onClick={() => void fixCheck(pr, check)}>Corriger avec Claude</button>
        )}
      </div>
      {open && (
        <div className="pr-check-detail">
          {failed
            ? <div className="pr-muted">Le log n'a pas pu être lu.</div>
            : log === null
              ? <div className="pr-muted">Chargement du log…</div>
              : <pre className="pr-check-log mono" data-testid="pr-check-log">{log}</pre>}
          <div>
            <button
              className="pr-btn pr-claude pr-small"
              disabled={log === null && !failed}
              onClick={() => void fixCheck(pr, check, log ?? undefined)}
            >Corriger avec Claude</button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ChecksTab({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const failing = pr.checks.filter((c) => c.outcome === 'failure')
  // One rerun per workflow run: its failed jobs all restart together.
  const runs = [...new Set(failing.flatMap((c) => (c.run ? [c.run.runId] : [])))]
  const rerunAll = async (): Promise<void> => {
    for (const runId of runs) await act({ type: 'rerun', runId, jobId: null })
  }
  return (
    <div className="pr-card" data-testid="pr-checks">
      <div className="pr-card-head">
        <b>{checksSummary(pr.checks)}</b>
        {runs.length > 0 && (
          <button className="pr-btn pr-small pr-push" disabled={busy !== null} onClick={() => void rerunAll()}>Relancer les échecs</button>
        )}
      </div>
      {pr.checks.map((c) => <CheckRow key={`${c.name}-${c.run?.jobId ?? ''}`} pr={pr} check={c} />)}
      <More count={pr.truncated.checks} url={pr.url} />
    </div>
  )
}

export function FilesTab({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy)
  const cwd = usePr((s) => s.cwd)
  const viewed = pr.files.filter((f) => f.viewed).length
  const threads = (path: string): number => pr.timeline.filter((i) => i.kind === 'thread' && i.thread.path === path).length
  const n = pr.files.length
  const openDiff = (): void => {
    if (!cwd || n === 0) return
    useApp.getState().openInCode(cwd, pr.files[0].path, 'diff')
  }
  return (
    <div className="pr-card" data-testid="pr-files">
      <div className="pr-card-head">
        <b>{plural(n, 'fichier', 'modifié')} · {viewed} vus</b>
        <button className="pr-btn pr-small pr-push" disabled={n === 0} onClick={openDiff}>Ouvrir le diff complet dans Code</button>
      </div>
      {pr.files.map((f) => {
        const c = threads(f.path)
        return (
          <div key={f.path} className="pr-list-row" data-testid="pr-file">
            <span className="pr-change mono" data-change={f.change}>{f.change}</span>
            <span className="pr-list-main mono">{f.path}</span>
            {c > 0 && <span className="pr-badge">{plural(c, 'conversation')}</span>}
            <span className="mono"><span className="pr-add">+{f.additions}</span> <span className="pr-del">−{f.deletions}</span></span>
            <label className="pr-viewed">
              <input
                type="checkbox"
                aria-label={`Vu : ${f.path}`}
                checked={f.viewed}
                disabled={busy !== null}
                onChange={(e) => void act({ type: 'viewed', path: f.path, viewed: e.target.checked })}
              /> Vu
            </label>
          </div>
        )
      })}
      <More count={pr.truncated.files} url={pr.url} />
    </div>
  )
}
