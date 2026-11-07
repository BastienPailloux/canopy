import type { PermissionRequest } from '../../shared/types'
import { answerPermission } from './sessionStore'
import { DiffView } from './ToolCard'
import { approvalDetail, toolDiff } from './toolDetail'

const REFUSAL = "L'utilisateur a refusé cette action."

/** Shows all of what is being approved: nothing here is cut or reduced to one line. */
export function PermissionCard(props: { request: PermissionRequest }): React.JSX.Element {
  const { request: r } = props
  const lines = toolDiff(r.toolName, r.input)
  const detail = approvalDetail(r.toolName, r.input)
  return (
    <div className="ask-card" data-testid="permission-card" role="group" aria-label={`Autorisation pour ${r.toolName}`}>
      <div className="ask-head">
        <span className="running-dot" aria-hidden="true" />
        <span className="name">{r.toolName}</span>
      </div>
      {detail.text !== undefined && <pre className="ask-detail" data-testid="permission-text">{detail.text}</pre>}
      {r.description && <p className="ask-text">{r.description}</p>}
      {r.decisionReason && <p className="ask-text muted">{r.decisionReason}</p>}
      {r.blockedPath && <p className="ask-text muted">Chemin concerné : <span className="mono">{r.blockedPath}</span></p>}
      {lines && <DiffView lines={lines} whole />}
      {detail.json !== undefined && <pre className="ask-detail" data-testid="permission-json">{detail.json}</pre>}
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
