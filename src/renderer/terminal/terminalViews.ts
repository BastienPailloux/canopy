import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalEvents } from '../../shared/api'
import { leftToMenu } from '../../shared/shortcuts'

/** One xterm per terminal, kept while the panel is hidden or another worktree is shown. */
export interface TerminalView {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  /** Chunks received before the snapshot was applied. */
  queue: TerminalEvents['data'][] | null
}

const views = new Map<string, TerminalView>()

const THEME = {
  background: '#0a0b0d',
  foreground: '#e7e9ec',
  cursor: '#a78bfa',
  selectionBackground: '#3a3352'
}

export function viewOf(id: string): TerminalView {
  const known = views.get(id)
  if (known) return known
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 1.4,
    scrollback: 2000,
    cursorBlink: true,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.attachCustomKeyEventHandler((e) => !leftToMenu(e))
  const el = document.createElement('div')
  el.className = 'term-host'
  const view: TerminalView = { term, fit, el, opened: false, queue: [] }
  views.set(id, view)
  term.onData((data) => { void window.canopy.writeTerminal(id, data).catch(() => undefined) })
  term.onResize(({ cols, rows }) => { void window.canopy.resizeTerminal(id, cols, rows).catch(() => undefined) })
  // Chunks already in the snapshot are dropped, the others written after it.
  void window.canopy.terminalSnapshot(id).then(({ data, end }) => {
    term.write(data)
    for (const chunk of view.queue ?? []) if (chunk.end > end) term.write(chunk.data)
    view.queue = null
  }, () => { view.queue = null })
  return view
}

export function writeToView({ id, data, end }: TerminalEvents['data']): void {
  const view = views.get(id)
  if (!view) return
  if (view.queue) view.queue.push({ id, data, end })
  else view.term.write(data)
}

export function noteExit(id: string, exitCode: number): void {
  views.get(id)?.term.write(`\r\n\u001b[2m[Processus terminé, code ${exitCode}]\u001b[0m\r\n`)
}

export function disposeView(id: string): void {
  const view = views.get(id)
  if (!view) return
  view.term.dispose()
  view.el.remove()
  views.delete(id)
}

/** Shows the terminal in `host`, sized to it. */
export function attachView(id: string, host: HTMLElement): TerminalView {
  const view = viewOf(id)
  host.replaceChildren(view.el)
  if (!view.opened) {
    view.term.open(view.el)
    view.opened = true
  }
  return view
}
