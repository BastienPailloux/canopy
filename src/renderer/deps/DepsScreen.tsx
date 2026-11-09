import { useEffect, useMemo, useState } from 'react'
import type { DepEntry } from '../../shared/deps'
import { basename, useApp } from '../store'
import { DepsLaunchDialog } from './DepsLaunchDialog'
import { initialSelection, lastCheckText, levelLabel, selectableKeys } from './depsModel'
import { recheckDeps, useDeps } from './depsStore'

/** Only the two URLs main builds (advisory, registry) are ever opened, through the checked external opener. */
function open(url: string): void {
  void window.canopy.openExternal(url).catch(() => undefined)
}

/** Re-renders every minute: « il y a N min » must move. */
function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function Row(props: { e: DepEntry; checked: boolean; showFile: boolean; onToggle: () => void }): React.JSX.Element {
  const { e } = props
  return (
    <tr data-testid="deps-row" data-key={e.key} data-level={e.level}>
      <td><input type="checkbox" aria-label={`Sélectionner ${e.name}`} checked={props.checked} onChange={props.onToggle} /></td>
      <td className="mono">
        {e.registryUrl
          ? <button className="deps-link" title="Page du registre" onClick={() => open(e.registryUrl!)}>{e.name}</button>
          : e.name}
        <span className="deps-eco">{e.ecosystem}</span>
      </td>
      {props.showFile && <td className="mono deps-file" title={e.manifest}>{e.manifest}</td>}
      <td className="mono">{e.installed ?? '—'}</td>
      <td className="mono">{e.target ?? '—'}</td>
      <td className="deps-level" data-level={e.level}>● {levelLabel(e.level)}</td>
      <td className="deps-why">
        <span>{e.reason}</span>
        {e.advisories.map((a) => (
          <button key={a.id} className="deps-link mono" title="Avis de sécurité" onClick={() => open(a.url)}>{a.id}</button>
        ))}
      </td>
    </tr>
  )
}

/** The « Dépendances » view: what the last check of the displayed repo found, and a launch on a selection. */
export function DepsScreen(): React.JSX.Element {
  const repo = useApp((s) => s.repo)
  const report = useDeps((s) => s.report)
  const loaded = useDeps((s) => s.loaded)
  const checking = useDeps((s) => s.checking)
  const error = useDeps((s) => s.error)
  const now = useNow()
  const entries = useMemo(() => report?.entries ?? [], [report])
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(entries))
  const [launching, setLaunching] = useState(false)

  // A new check (or another repo) starts from its critical entries again.
  const stamp = `${report?.repo ?? ''}:${report?.checkedAt ?? ''}`
  useEffect(() => { setSelected(initialSelection(entries)) }, [stamp])

  const chosen = entries.filter((e) => selected.has(e.key))
  const selectable = selectableKeys(entries)
  const allChecked = selectable.length > 0 && selectable.every((k) => selected.has(k))
  const showFile = new Set(entries.map((e) => e.manifest)).size > 1
  const toggle = (key: string): void => setSelected((s) => {
    const next = new Set(s)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const toggleAll = (): void => setSelected((s) => {
    const next = new Set(s)
    for (const k of selectable) if (allChecked) next.delete(k); else next.add(k)
    return next
  })

  const checked = report ? lastCheckText(report, now) : ''
  let body: React.JSX.Element
  if (!loaded) body = <p className="deps-empty">Chargement…</p>
  else if (!report) body = <p className="deps-empty">Première vérification en cours…</p>
  else if (report.manifests === 0) body = <p className="deps-empty">Aucun fichier de dépendances reconnu</p>
  else if (entries.length === 0) body = <div className="deps-empty"><strong>Tout est à jour</strong>{checked && <span>{checked}</span>}</div>
  else body = (
    <table className="deps-table">
      <thead>
        <tr>
          <th><input type="checkbox" aria-label="Tout cocher" checked={allChecked} disabled={selectable.length === 0} onChange={toggleAll} /></th>
          <th>Paquet</th>
          {showFile && <th>Fichier</th>}
          <th>Installée</th>
          <th>Cible</th>
          <th>Criticité</th>
          <th>Pourquoi</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => <Row key={e.key} e={e} checked={selected.has(e.key)} showFile={showFile} onToggle={() => toggle(e.key)} />)}
      </tbody>
    </table>
  )

  return (
    <div className="deps-screen">
      <div className="deps-head">
        <h2>Dépendances{report ? ` · ${basename(report.repo)}` : ''}</h2>
        {checked && entries.length > 0 && <span className="deps-checked">{checked}</span>}
      </div>
      <div className="deps-body">
        {body}
        {error && <p className="deps-error" role="alert">{error}</p>}
        {report && report.errors.length > 0 && (
          <ul className="deps-errors">{report.errors.map((m) => <li key={m}>{m}</li>)}</ul>
        )}
      </div>
      <div className="deps-bar">
        <span>{chosen.length} {chosen.length > 1 ? 'sélectionnées' : 'sélectionnée'}</span>
        <button className="secondary" data-testid="deps-recheck" disabled={checking || !repo} onClick={() => void recheckDeps()}>
          {checking ? 'Vérification…' : 'Revérifier'}
        </button>
        <button className="primary" data-testid="deps-launch" disabled={chosen.length === 0} onClick={() => setLaunching(true)}>
          Lancer Claude sur la mise à jour
        </button>
      </div>
      {launching && report && <DepsLaunchDialog repo={report.repo} entries={chosen} onClose={() => setLaunching(false)} />}
    </div>
  )
}
