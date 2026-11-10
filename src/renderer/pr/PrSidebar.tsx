import { useEffect, useMemo, useState } from 'react'
import type { PrDetail, PrReviewer } from '../../shared/pr'
import { useApp } from '../store'
import { useSessions } from '../sessions/sessionStore'
import { testPR } from '../terminal/terminalStore'
import { useLinear } from '../tickets/linearStore'
import { useTickets } from '../tickets/ticketStore'
import { linkedTicket, REVIEWER_STATUS, reviewerChoices, sessionText } from './mergeModel'
import { act, usePr } from './prStore'

interface Choice { id: string; label: string; hint?: string }

/** A button that opens a filterable list; picking an entry closes it and calls `onPick`. */
function Picker(props: { label: string; filterLabel: string; choices: Choice[]; query: string; onQuery: (q: string) => void; onPick: (id: string) => void; disabled: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="pr-picker">
      <button className="pr-small" aria-expanded={open} disabled={props.disabled} onClick={() => { setOpen(!open); props.onQuery('') }}>{props.label}</button>
      {open && (
        <div className="pr-menu">
          <input aria-label={props.filterLabel} autoFocus value={props.query} onChange={(e) => props.onQuery(e.target.value)} placeholder="Filtrer…" />
          <div role="listbox" aria-label={props.label}>
            {props.choices.map((c) => (
              <button key={c.id} role="option" aria-selected={false} onClick={() => { setOpen(false); props.onPick(c.id) }}>
                <span>{c.label}</span>{c.hint && <span className="pr-muted pr-note">{c.hint}</span>}
              </button>
            ))}
            {props.choices.length === 0 && <div className="pr-muted pr-note pr-menu-empty">Aucun résultat</div>}
          </div>
        </div>
      )}
    </div>
  )
}

const matches = (q: string, ...texts: string[]): boolean => {
  const s = q.trim().toLowerCase()
  return !s || texts.some((t) => t.toLowerCase().includes(s))
}

function Reviewers({ pr }: { pr: PrDetail }): React.JSX.Element {
  const busy = usePr((s) => s.busy !== null)
  const options = usePr((s) => s.options)
  const [query, setQuery] = useState('')
  const choices = reviewerChoices({ suggested: options?.suggested ?? [], assignable: options?.assignable ?? [] }, pr.reviewers, query).map((s) => ({ id: s.login, label: s.login, hint: s.hint }))
  const again = (r: PrReviewer): boolean => r.status !== 'pending'
  return (
    <section className="pr-side-section" aria-label="Reviewers">
      <h3>Reviewers</h3>
      {pr.reviewers.map((r) => (
        <div key={r.login} className="pr-side-row" data-testid="pr-reviewer">
          <span className="pr-side-main">{r.login}</span>
          <span className="pr-badge" data-tone={r.status === 'approved' ? 'ok' : r.status === 'changes' ? 'bad' : undefined}>{REVIEWER_STATUS[r.status]}</span>
          {again(r) && (
            <button className="pr-small" aria-label={`Redemander une review à ${r.login}`} disabled={busy} onClick={() => void act({ type: 'reviewers', add: [r.login], remove: [] })}>↻</button>
          )}
        </div>
      ))}
      {pr.reviewers.length === 0 && <div className="pr-muted pr-note">Personne</div>}
      <Picker label="Demander une review" filterLabel="Filtrer les relecteurs" choices={choices} query={query} onQuery={setQuery} disabled={busy}
        onPick={(login) => void act({ type: 'reviewers', add: [login], remove: [] })} />
    </section>
  )
}

/** Assignees and labels: the same chips with a remove button, and a picker over what the repo offers. */
function Tags(props: { title: string; noun: string; type: 'assignees' | 'labels'; current: string[]; all: string[]; add: string; remove: (x: string) => string }): React.JSX.Element {
  const busy = usePr((s) => s.busy !== null)
  const [query, setQuery] = useState('')
  const choices = props.all.filter((x) => !props.current.includes(x) && matches(query, x)).map((x) => ({ id: x, label: x }))
  return (
    <section className="pr-side-section" aria-label={props.title}>
      <h3>{props.title}</h3>
      <div className="pr-chips">
        {props.current.map((x) => (
          <span key={x} className="pr-chip">{x}
            <button aria-label={props.remove(x)} disabled={busy} onClick={() => void act({ type: props.type, add: [], remove: [x] })}>×</button>
          </span>
        ))}
        {props.current.length === 0 && <span className="pr-muted pr-note">Aucun</span>}
      </div>
      <Picker label={props.add} filterLabel={`Filtrer ${props.noun}`} choices={choices} query={query} onQuery={setQuery} disabled={busy}
        onPick={(x) => void act({ type: props.type, add: [x], remove: [] })} />
    </section>
  )
}

function useServicePorts(cwd: string): number[] {
  const [ports, setPorts] = useState<number[]>([])
  useEffect(() => {
    let live = true
    const read = (): void => {
      window.canopy.terminalPorts(cwd).then((p) => { if (live) setPorts(Object.values(p)) }, () => undefined)
    }
    read()
    const off = window.canopy.on('terminal:portsChanged', read)
    return () => { live = false; off() }
  }, [cwd])
  return ports
}

/** The right column of the PR tab: who reviews, assignees, labels, the linked ticket, Claude, test and link. */
export function PrSidebar({ pr }: { pr: PrDetail }): React.JSX.Element {
  const options = usePr((s) => s.options)
  const cwd = usePr((s) => s.cwd)
  const linear = useLinear((s) => s.links)
  const tickets = useTickets((s) => s.entries)
  const ticket = useMemo(() => linkedTicket(pr.head, linear, tickets), [pr.head, linear, tickets])
  const sessionState = useSessions((s) => (cwd ? s.tabs[s.active[cwd] ?? '']?.state : undefined))
  const ports = useServicePorts(cwd ?? '')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const copy = (): void => {
    navigator.clipboard.writeText(pr.url).then(() => {
      setCopyError(false)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, () => setCopyError(true))
  }
  return (
    <aside className="pr-side" aria-label="Détails de la PR">
      <Reviewers pr={pr} />
      <Tags title="Assignés" noun="les collaborateurs" type="assignees" current={pr.assignees} all={options?.assignable ?? []} add="Assigner quelqu’un" remove={(x) => `Retirer ${x}`} />
      <Tags title="Labels" noun="les labels" type="labels" current={pr.labels} all={options?.labels ?? []} add="Ajouter un label" remove={(x) => `Retirer le label ${x}`} />
      {ticket && (
        <section className="pr-side-section" aria-label="Ticket lié">
          <h3>Ticket lié</h3>
          <div className="pr-side-row"><span className="mono">{ticket.id}</span>{ticket.title && <span className="pr-side-main">{ticket.title}</span>}</div>
          <div className="pr-muted pr-note">Passera en « Done » au merge</div>
        </section>
      )}
      <section className="pr-side-section" aria-label="Session Claude">
        <h3>Session Claude</h3>
        <div className="pr-side-row"><span className="pr-side-main">{sessionText(sessionState)}</span></div>
        <button className="pr-link pr-note" onClick={() => useApp.getState().setView('sessions')}>Ouvrir les sessions</button>
      </section>
      <section className="pr-side-section" aria-label="Tester la PR">
        <h3>Tester la PR</h3>
        <button className="pr-btn" disabled={!cwd} onClick={() => cwd && void testPR(cwd)}>Tester la PR</button>
        {ports.length > 0 && <div className="pr-muted pr-note">Lancer les services sur {ports.map((p) => `:${p}`).join(', ')}</div>}
      </section>
      <button className="pr-btn" onClick={copy}>{copied ? 'Lien copié' : 'Copier le lien de la PR'}</button>
      {copyError && <div className="pr-muted pr-note" role="alert">Copie impossible</div>}
    </aside>
  )
}
