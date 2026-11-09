import { create } from 'zustand'
import type { TerminalEvents, TerminalInfo } from '../../shared/api'
import { isRepoNotTrusted } from '../../shared/errors'
import { askClaude, confirmTrust } from '../sessions/sessionStore'
import { formatLogs } from './logs'
import { disposeView, noteExit, writeToView } from './terminalViews'

interface TerminalsState {
  /** The panel is shown (for every worktree). */
  open: boolean
  terms: Record<string, TerminalInfo>
  /** Selected terminal per worktree. */
  active: Record<string, string>
  /** Why the last action of a worktree failed. */
  notices: Record<string, string>
}

export const useTerminals = create<TerminalsState>(() => ({ open: false, terms: {}, active: {}, notices: {} }))

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

const setNotice = (cwd: string, text: string | null): void => {
  useTerminals.setState((s) => {
    const { [cwd]: _old, ...rest } = s.notices
    return { notices: text === null ? rest : { ...rest, [cwd]: text } }
  })
}

export const setTerminalsOpen = (open: boolean): void => useTerminals.setState({ open })
export const toggleTerminals = (): void => useTerminals.setState((s) => ({ open: !s.open }))
export const selectTerminal = (cwd: string, id: string): void => {
  useTerminals.setState((s) => ({ active: { ...s.active, [cwd]: id } }))
}

/** Adds or refreshes terminals. A restarted service replaces the one with its name. */
/** A process may have ended before its first event could be applied: the list is read again after. */
async function upsert(infos: TerminalInfo[]): Promise<void> {
  const replaced: string[] = []
  useTerminals.setState((s) => {
    const terms = { ...s.terms }
    for (const info of infos) {
      if (info.kind !== 'shell') {
        for (const old of Object.values(terms)) {
          if (old.cwd === info.cwd && old.kind === info.kind && old.label === info.label && old.id !== info.id) {
            delete terms[old.id]
            replaced.push(old.id)
          }
        }
      }
      terms[info.id] = info
    }
    const last = infos.at(-1)
    return { terms, active: last ? { ...s.active, [last.cwd]: last.id } : s.active }
  })
  replaced.forEach(disposeView)
  if (infos[0]) await loadTerminals(infos[0].cwd)
}

/** Terminals live in the main process: shows the ones a reload or another view left running. */
export async function loadTerminals(cwd: string): Promise<void> {
  const list = await window.canopy.listTerminals(cwd).catch((): TerminalInfo[] => [])
  useTerminals.setState((s) => {
    const terms = { ...s.terms }
    for (const t of list) terms[t.id] = t
    const kept = s.active[cwd] && terms[s.active[cwd]] ? s.active[cwd] : list[0]?.id
    return { terms, active: kept ? { ...s.active, [cwd]: kept } : s.active }
  })
}

export async function newShell(cwd: string): Promise<void> {
  try {
    setNotice(cwd, null)
    await upsert([await window.canopy.createTerminal(cwd)])
  } catch (e) {
    setNotice(cwd, errorText(e))
  }
}

export function stopTerminal(id: string): void {
  void window.canopy.killTerminal(id).catch(() => undefined)
}

export function closeTerminal(id: string): void {
  const t = useTerminals.getState().terms[id]
  void window.canopy.removeTerminal(id).catch(() => undefined)
  disposeView(id)
  useTerminals.setState((s) => {
    const { [id]: _gone, ...terms } = s.terms
    if (!t || s.active[t.cwd] !== id) return { terms }
    const { [t.cwd]: _active, ...active } = s.active
    const next = Object.values(terms).find((o) => o.cwd === t.cwd)
    return { terms, active: next ? { ...active, [t.cwd]: next.id } : active }
  })
}

/** Scripts only run for an approved config: main refuses otherwise, and the usual dialog asks. */
async function withTrust<T>(cwd: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (!isRepoNotTrusted(e)) throw e
    if (!(await confirmTrust(cwd))) throw new Error("Dépôt non approuvé : rien n'a été lancé.")
    return call()
  }
}

export async function restartService(id: string): Promise<void> {
  const t = useTerminals.getState().terms[id]
  if (!t || t.kind !== 'service') return
  try {
    setNotice(t.cwd, null)
    await upsert(await withTrust(t.cwd, () => window.canopy.runServices(t.cwd, t.label)))
  } catch (e) {
    setNotice(t.cwd, errorText(e))
  }
}

/** The exit code of a terminal, known now or when it comes. Null if the terminal is closed first. */
function exitCodeOf(id: string): Promise<number | null> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const t = useTerminals.getState().terms[id]
      if (!t) {
        resolve(null)
        return true
      }
      if (!t.running) {
        resolve(t.exitCode ?? -1)
        return true
      }
      return false
    }
    if (check()) return
    const unsubscribe = useTerminals.subscribe(() => { if (check()) unsubscribe() })
  })
}

/** « Tester la PR »: the setup commands, then, if they succeeded, the services. */
export async function testPR(cwd: string): Promise<void> {
  setTerminalsOpen(true)
  setNotice(cwd, null)
  try {
    const setup = await withTrust(cwd, () => window.canopy.runSetup(cwd))
    if (setup) {
      await upsert([setup])
      const code = await exitCodeOf(setup.id)
      if (code === null) {
        setNotice(cwd, 'Le setup a été fermé : les services ne sont pas lancés.')
        return
      }
      if (code !== 0) {
        setNotice(cwd, `Le setup a échoué (code ${code}) : les services ne sont pas lancés.`)
        return
      }
    }
    const services = await withTrust(cwd, () => window.canopy.runServices(cwd))
    if (services.length > 0) await upsert(services)
    else if (!setup) setNotice(cwd, 'Rien à lancer : déclare un setup ou un service dans Réglages → Tester la PR, ou dans .canopy/config.json.')
  } catch (e) {
    setNotice(cwd, errorText(e))
  }
}

/** The last lines of a terminal go to the worktree's selected Claude session. */
export async function sendLogs(id: string): Promise<void> {
  const t = useTerminals.getState().terms[id]
  if (!t) return
  try {
    const { data } = await window.canopy.terminalSnapshot(id)
    askClaude(t.cwd, formatLogs(t.label, data))
  } catch (e) {
    setNotice(t.cwd, errorText(e))
  }
}

/** Subscribes to terminal events for the app's lifetime. */
export function connectTerminals(): () => void {
  const on = <K extends keyof TerminalEvents>(key: K, cb: (e: TerminalEvents[K]) => void): (() => void) =>
    window.canopy.on(`terminal:${key}`, (payload) => cb(payload as TerminalEvents[K]))
  const off = [
    on('data', writeToView),
    on('exit', ({ id, exitCode }) => {
      noteExit(id, exitCode)
      useTerminals.setState((s) => (s.terms[id] ? { terms: { ...s.terms, [id]: { ...s.terms[id], running: false, exitCode } } } : s))
    })
  ]
  return () => off.forEach((unsubscribe) => unsubscribe())
}
