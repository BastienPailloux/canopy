import type { PermissionRequest } from '../../shared/types'
import { answerPermission } from './sessionStore'
import { DiffView, toolDiff, toolTarget } from './ToolCard'

const REFUSAL = "L'utilisateur a refusé cette action."

export function PermissionCard(props: { request: PermissionRequest; cwd: string }): React.JSX.Element {
  const { request: r, cwd } = props
  const lines = toolDiff(r.toolName, r.input)
  const target = toolTarget(r.toolName, r.input, cwd)
  return (
    <div className="ask-card" data-testid="permission-card" role="group" aria-label={`Autorisation pour ${r.toolName}`}>
      <div className="ask-head">
        <span className="running-dot" aria-hidden="true" />
        <span className="name">{r.toolName}</span>
        <span className="target" title={target}>{target}</span>
      </div>
      {r.description && <p className="ask-text">{r.description}</p>}
      {r.decisionReason && <p className="ask-text muted">{r.decisionReason}</p>}
      {r.blockedPath && <p className="ask-text muted">Chemin concerné : <span className="mono">{r.blockedPath}</span></p>}
      {lines && <DiffView lines={lines} />}
      <div className="ask-actions">
        <button type="button" className="primary" onClick={() => answerPermission(r.requestId, { allow: true })}>Autoriser</button>
        {r.canAlways && (
          <button type="button" className="secondary" onClick={() => answerPermission(r.requestId, { allow: true, always: true })}>Toujours</button>
        )}
        <button type="button" className="secondary" onClick={() => answerPermission(r.requestId, { allow: false, message: REFUSAL })}>Refuser</button>
      </div>
    </div>
  )
}
