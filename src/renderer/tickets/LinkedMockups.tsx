import { useEffect, useRef, useState } from 'react'
import { shownStatus, type Mockup } from '../../shared/mockups'
import { AddMockupDialog } from '../mockups/AddMockupDialog'
import { MockupTemplate } from '../mockups/MockupCard'
import { useTicketList } from '../mockups/MockupsScreen'
import { linkedTicket, upsertMockup, useMockups } from '../mockups/mockupStore'
import { useApp } from '../store'

/** Screen 3b, « Maquettes liées »: the ticket's mockups, and a menu to link one, add a link or have Claude make one. */
export function LinkedMockups(props: { repo: string; ticket: string }): React.JSX.Element {
  const { repo, ticket } = props
  const list = useMockups((s) => s.list)
  const tickets = useTicketList()
  const linked = list.filter((m) => m.ticket === ticket)
  const free = list.filter((m) => m.ticket !== ticket && !linkedTicket(m, tickets))
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const app = useApp.getState()

  const link = (m: Mockup, to: string | null): void => {
    setError(null)
    window.canopy.patchMockup(repo, m.id, { ticket: to }).then((r) => upsertMockup(repo, r), (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const open = (m: Mockup): void => {
    app.setSelectedMockup(m.id)
    app.setOpenMockup(m.id)
    app.setView('mockups')
  }
  const generate = (): void => {
    app.setPendingMockupTicket(ticket)
    app.setOpenMockup('new')
    app.setView('mockups')
  }

  return (
    <section className="linked-mockups" aria-label="Maquettes liées">
      <h3>Maquettes liées</h3>
      {error && <p className="editor-error" role="alert">{error}</p>}
      <div className="linked-mockups-row">
        {linked.map((m) => (
          <span key={m.id} className="mockup-chip">
            <button className="mockup-chip-open" title="Modifier la maquette" onClick={() => open(m)}>
              <MockupTemplate kind={m.kind} status={shownStatus(m, linkedTicket(m, tickets))} size="chip" />
              <span className="mockup-chip-title">{m.title}</span>
            </button>
            <button className="mockup-chip-unlink" aria-label={`Délier ${m.title}`} title="Délier" onClick={() => link(m, null)}>×</button>
          </span>
        ))}
        <div className="mockup-link-menu-wrap">
          <button className="mockup-link-add" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            + Lier ou générer une maquette
          </button>
          {menu && (
            <LinkMenu free={free} onClose={() => setMenu(false)} onLink={(m) => link(m, ticket)}
              onPaste={() => setAdding(true)} onGenerate={generate} />
          )}
        </div>
      </div>
      {adding && <AddMockupDialog repo={repo} ticket={ticket} onClose={() => setAdding(false)} />}
    </section>
  )
}

function LinkMenu(props: {
  free: Mockup[]
  onClose: () => void
  onLink: (m: Mockup) => void
  onPaste: () => void
  onGenerate: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose

  // Focus on the first item; Escape, a click outside or a choice closes it.
  useEffect(() => {
    const el = ref.current
    el?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (el && !el.parentElement?.contains(e.target as Node)) close.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close.current() }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(el?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
      if (next) { e.preventDefault(); next.focus() }
    }
    document.addEventListener('mousedown', onDown)
    el?.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); el?.removeEventListener('keydown', onKey) }
  }, [])

  const pick = (fn: () => void) => (): void => { props.onClose(); fn() }
  return (
    <div ref={ref} className="mockup-link-menu" role="menu" aria-label="Lier ou générer une maquette">
      {props.free.length > 0 && <span className="mockup-link-menu-title" aria-hidden="true">Maquettes sans ticket</span>}
      {props.free.map((m) => (
        <button key={m.id} role="menuitem" onClick={pick(() => props.onLink(m))}>{m.title}</button>
      ))}
      {props.free.length > 0 && <hr />}
      <button role="menuitem" onClick={pick(props.onPaste)}>Coller un lien claude.ai…</button>
      <button role="menuitem" onClick={pick(props.onGenerate)}>✦ Générer avec Claude</button>
    </div>
  )
}
