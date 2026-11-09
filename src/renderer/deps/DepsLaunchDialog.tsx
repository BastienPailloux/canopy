import { useCallback, useRef, useState } from 'react'
import { defaultDepsBranch, type DepEntry } from '../../shared/deps'
import type { LaunchTarget } from '../../shared/tickets'
import { useModal } from '../shell/useModal'
import { runDepsLaunch } from '../tickets/launchFlow'
import { LaunchWhere } from '../tickets/LaunchWhere'
import { useRepoRefs } from '../tickets/TicketsScreen'
import { levelLabel, promptSplit } from './depsModel'

/** Where to launch Claude on the selected `entries`, the branch name, then one click. */
export function DepsLaunchDialog(props: { repo: string; entries: DepEntry[]; onClose: () => void }): React.JSX.Element {
  const { repo, entries, onClose } = props
  const dialog = useRef<HTMLDivElement>(null)
  const refs = useRepoRefs(repo, null)
  const [branch, setBranch] = useState(() => defaultDepsBranch(entries, new Date()))
  const [target, setTarget] = useState<LaunchTarget | null>(null)
  const [startClaude, setStartClaude] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { safe, unsafe } = promptSplit(entries)
  const onTarget = useCallback((t: LaunchTarget | null) => setTarget(t), [])
  useModal(dialog, () => { if (!busy) onClose() })

  const canLaunch = !busy && target !== null && safe.length > 0
  const launch = async (): Promise<void> => {
    if (!canLaunch || !target) return
    setBusy(true)
    setError(null)
    try {
      await runDepsLaunch(repo, { branch: branch.trim(), target }, safe, { startClaude })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div ref={dialog} className="launch deps-dialog" role="dialog" aria-modal="true" aria-label="Lancer Claude sur la mise à jour"
        data-testid="deps-dialog">
        <h2>Lancer Claude sur la mise à jour</h2>
        <ul className="deps-summary">
          {entries.map((e) => (
            <li key={e.key}>
              <span className="mono">{e.name}</span>
              <span className="mono deps-versions">{e.installed ?? '?'} → {e.target ?? '—'}</span>
              <span className="deps-level" data-level={e.level}>{levelLabel(e.level)}</span>
            </li>
          ))}
        </ul>
        {unsafe.length > 0 && (
          <p className="launch-warn">
            Non transmises à Claude (nom ou chemin inhabituel) : {unsafe.map((e) => e.name).join(', ')}
          </p>
        )}

        <LaunchWhere repo={repo} refs={refs} branch={branch} onBranch={setBranch} onTarget={onTarget} />

        <section className="launch-checks">
          <label className="check">
            <input type="checkbox" checked={startClaude} onChange={(e) => setStartClaude(e.target.checked)} />
            Démarrer Claude
          </label>
        </section>

        {error && <p className="launch-error" role="alert">{error}</p>}

        <div className="deps-dialog-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>Annuler</button>
          <button className="primary" disabled={!canLaunch} onClick={() => void launch()}>{busy ? 'Lancement…' : 'Lancer'}</button>
        </div>
      </div>
    </div>
  )
}
