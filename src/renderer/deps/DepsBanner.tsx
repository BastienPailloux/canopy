import { basename, useApp } from '../store'
import { bannerParts } from './depsModel'
import { dismissDepsBanner, useDeps } from './depsStore'

/** The red notice under the header, on every view, while the displayed repo has a critical dependency not dismissed. */
export function DepsBanner(): React.JSX.Element | null {
  const report = useDeps((s) => s.report)
  const banner = useDeps((s) => s.banner)
  if (!banner || !report || !report.entries.some((e) => e.level === 'critical')) return null
  return (
    <div className="deps-banner" role="status" data-testid="deps-banner">
      <span className="deps-banner-icon" aria-hidden="true">⚠</span>
      <span className="deps-banner-text">
        {bannerParts(report.entries, basename(report.repo)).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}
      </span>
      <button className="deps-banner-see" onClick={() => useApp.getState().setView('deps')}>Voir</button>
      <button className="deps-banner-close" aria-label="Fermer l'alerte" onClick={() => void dismissDepsBanner()}>×</button>
    </div>
  )
}
