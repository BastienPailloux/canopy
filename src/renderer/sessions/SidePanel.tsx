import { useEffect, useMemo, useRef, useState } from 'react'
import type { BaseRef, ChangedFile } from '../../shared/types'
import { createOrdering, poll, POLL_DEGRADED_MS, POLL_HEALTHY_MS } from '../shell/polling'
import { useLayout } from '../shell/layoutStore'
import { useApp } from '../store'
import { useBranchBase } from '../code/useBranchBase'
import { prPrompt, rebasePrompt } from './panelPrompts'
import { askClaude, useSessions } from './sessionStore'

const KIND_COLOR: Record<ChangedFile['kind'], string> = { A: 'var(--add)', M: 'var(--warn)', D: 'var(--del)', R: 'var(--accent)' }

/** Files changed against the comparison base, kept up to date; a failing read keeps the last good one. */
function useChanges(cwd: string, picked: string | undefined): { base: BaseRef | null; files: ChangedFile[]; error: string | null } {
  const [state, setState] = useState<{ base: BaseRef | null; files: ChangedFile[]; error: string | null }>({ base: null, files: [], error: null })
  const key = useRef('')
  key.current = `${cwd}\0${picked ?? ''}`
  const order = useRef(createOrdering())
  const [watchFailed, setWatchFailed] = useState(false)

  useEffect(() => {
    const asked = key.current
    setState({ base: null, files: [], error: null })
    const read = (): void => {
      const apply = order.current.begin(asked)
      window.canopy.codeChanges(cwd, picked).then(
        (r) => { if (key.current === asked && apply()) setState({ base: r.base, files: r.files, error: null }) },
        (e: unknown) => { if (key.current === asked && apply()) setState((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) })) }
      )
    }
    read()
    const stopPolling = poll(read, watchFailed ? POLL_DEGRADED_MS : POLL_HEALTHY_MS)
    window.addEventListener('focus', read)
    const off = window.canopy.on('code:changed', (p) => { if ((p as { cwd?: string } | null)?.cwd === cwd) read() })
    const offError = window.canopy.on('code:watchError', (p) => { if ((p as { cwd?: string } | null)?.cwd === cwd) setWatchFailed(true) })
    return () => { stopPolling(); window.removeEventListener('focus', read); off(); offError() }
  }, [cwd, picked, watchFailed])

  return state
}

/** Right panel of the Sessions view: what the branch changes, and the two actions Claude carries out. */
export function SidePanel({ cwd, branch }: { cwd: string; branch: string }): React.JSX.Element {
  const picked = useApp((s) => s.bases[cwd])
  const { base, files, error } = useChanges(cwd, picked)
  const stacked = useBranchBase(cwd, branch).base
  const activeState = useSessions((s) => {
    const id = s.active[cwd]
    return id ? s.tabs[id]?.state : undefined
  })
  const busy = activeState === 'running' || activeState === 'waiting'
  const totals = useMemo(() => ({
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0)
  }), [files])
  const width = useLayout((s) => s.right)
  const openCode = (): void => useApp.getState().setView('code')

  return (
    <aside className="side-panel" aria-label="Panneau latéral" style={{ width }}>
      <section>
        <div className="head">
          <button className="title-link" onClick={openCode} data-testid="changes-link">
            Changements{base ? ` vs ${base.name}` : ''}
          </button>
          <span className="mono totals"><span className="add">+{totals.added}</span> <span className="del">−{totals.deleted}</span></span>
        </div>
        {error && <p className="warn" role="alert">{files.length > 0 ? 'Données périmées : ' : 'Lecture impossible : '}{error}</p>}
        {!error && base && files.length === 0 && <p className="muted">Aucun changement.</p>}
        <div className="files">
          {files.map((f) => (
            <button key={f.path} className="file" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              onClick={() => useApp.getState().openInCode(cwd, f.path, 'diff')}>
              <span className="kind" style={{ color: KIND_COLOR[f.kind] }}>{f.kind}</span>
              <span className="path">{f.path}</span>
              <span className="add">{f.binary ? '' : f.added}</span>
              <span className="del">{f.binary ? '' : f.deleted}</span>
            </button>
          ))}
        </div>
      </section>
      <div className="actions">
        {stacked !== null && <p className="muted mono" data-testid="pr-target">Cible : {stacked}</p>}
        <button className="primary" disabled={busy} title={busy ? 'Claude travaille sur cette session' : undefined}
          onClick={() => askClaude(cwd, prPrompt(stacked ?? undefined))}>Créer la PR</button>
        <button className="secondary" disabled={busy || !base} title={busy ? 'Claude travaille sur cette session' : undefined}
          onClick={() => { if (base) askClaude(cwd, rebasePrompt(base.ref)) }}>
          Rebaser{base ? ` sur ${base.name}` : ''}
        </button>
      </div>
    </aside>
  )
}
