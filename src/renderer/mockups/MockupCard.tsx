import { MOCKUP_STATUS_COLOR, MOCKUP_STATUS_LABEL, type Mockup, type MockupKind, type MockupStatus } from '../../shared/mockups'

/** Background and accent of a template, by the status shown, in the mockup's palette. */
const TINT: Record<MockupStatus, { tint: string; accent: string }> = {
  done: { tint: '#18241D', accent: '#3FB950' },
  wip: { tint: '#17202E', accent: '#A78BFA' },
  todo: { tint: '#221C2C', accent: '#A78BFA' },
}

/**
 * The phone or web outline standing for a mockup (claude.ai gives no thumbnail). `card`: in a gallery card;
 * `large`: the detail panel; `chip`: a small tinted box.
 */
export function MockupTemplate(props: { kind: MockupKind; status: MockupStatus; size: 'card' | 'large' | 'chip' }): React.JSX.Element {
  const { tint, accent } = TINT[props.status]
  const style = { '--tpl-tint': tint, '--tpl-accent': accent } as React.CSSProperties
  return (
    <span className="tpl" data-size={props.size} data-kind={props.kind} style={style} aria-hidden="true">
      {props.size !== 'chip' && (props.kind === 'phone'
        ? (
          <span className="tpl-phone">
            <span className="bar w70" /><span className="block" /><span className="line" /><span className="line w60" />
            <span className="cta" />
          </span>
        )
        : (
          <span className="tpl-web">
            <span className="top" />
            <span className="body">
              <span className="side" />
              <span className="content"><span className="line w50" /><span className="block" /><span className="cta" /></span>
            </span>
          </span>
        ))}
    </span>
  )
}

export function StatusPill({ status }: { status: MockupStatus }): React.JSX.Element {
  const c = MOCKUP_STATUS_COLOR[status]
  return <span className="mockup-status" style={{ background: c.bg, color: c.fg }}>{MOCKUP_STATUS_LABEL[status]}</span>
}

/** The mockup's ticket id: struck through when the ticket is archived or gone, « Sans ticket » when none. */
export function TicketRef(props: { id: string | undefined; live: boolean }): React.JSX.Element {
  if (!props.id) return <span>Sans ticket</span>
  return props.live
    ? <span className="mono">{props.id}</span>
    : <s className="mono" title="Ticket archivé ou introuvable">{props.id}</s>
}

/** A gallery card: click selects, double-click opens the edit screen. */
export function MockupCard(props: {
  mockup: Mockup
  status: MockupStatus
  ticketLive: boolean
  when: string
  selected: boolean
  onSelect: () => void
  onOpen: () => void
}): React.JSX.Element {
  const { mockup: m } = props
  return (
    <button className="mockup-card" aria-pressed={props.selected} data-testid={`mockup-${m.id}`} title={m.title}
      onClick={props.onSelect} onDoubleClick={props.onOpen}>
      <MockupTemplate kind={m.kind} status={props.status} size="card" />
      <span className="mockup-card-body">
        <span className="mockup-card-title">{m.title}</span>
        <span className="mockup-card-meta"><TicketRef id={m.ticket} live={props.ticketLive} /><span>{props.when}</span></span>
        <StatusPill status={props.status} />
      </span>
    </button>
  )
}
