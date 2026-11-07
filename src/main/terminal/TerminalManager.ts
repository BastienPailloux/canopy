import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import type { TerminalEvents, TerminalInfo, TerminalKind } from '../../shared/api'

/** The part of a node-pty process used here. */
export interface PtyProcess {
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pid?: number
}
export type SpawnPty = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
) => PtyProcess

export interface TerminalOptions {
  /** Run through the login shell, which then exits. Without it: an interactive shell. */
  command?: string
  env?: Record<string, string>
  label?: string
  kind?: TerminalKind
  port?: number
}

export interface TerminalManagerOptions {
  spawn: SpawnPty
  /** The login shell env, without ELECTRON_RUN_AS_NODE. */
  env: () => NodeJS.ProcessEnv
}

/** After a hangup, how long a process has to end before it is killed with its whole group. */
const KILL_GRACE_MS = 2000
const MAX_LINES = 2000
const COLS = 80
const ROWS = 24

interface Terminal {
  info: TerminalInfo
  pty: PtyProcess
  buffer: string
  lines: number
  end: number
  killTimer?: NodeJS.Timeout
}

const count = (s: string): number => s.split('\n').length - 1

/** Pseudo-terminals, global like sessions: they outlive the views that show them. */
export class TerminalManager extends EventEmitter {
  private readonly terminals = new Map<string, Terminal>()
  private seq = 0

  constructor(private readonly o: TerminalManagerOptions) {
    super()
  }

  on<K extends keyof TerminalEvents>(event: K, cb: (e: TerminalEvents[K]) => void): this {
    return super.on(event, cb)
  }

  create(cwd: string, o: TerminalOptions = {}): string {
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      // reported below
    }
    if (!isDir) throw new Error(`Dossier introuvable : ${cwd}`)

    const base = this.o.env()
    const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    for (const [k, v] of Object.entries({ ...base, ...o.env })) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
    const shell = base.SHELL || '/bin/zsh'
    let pty: PtyProcess
    try {
      pty = this.o.spawn(shell, o.command === undefined ? ['-il'] : ['-ilc', o.command], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env })
    } catch (err) {
      throw new Error(`Terminal impossible à lancer : ${(err as Error).message}`)
    }

    const id = `term-${++this.seq}`
    const kind = o.kind ?? 'shell'
    const term: Terminal = {
      info: { id, cwd, label: o.label ?? (kind === 'shell' ? `Terminal ${this.seq}` : kind), kind, running: true, ...(o.port !== undefined ? { port: o.port } : {}) },
      pty,
      buffer: '',
      lines: 0,
      end: 0
    }
    this.terminals.set(id, term)
    pty.onData((data) => this.append(term, data))
    pty.onExit(({ exitCode: code, signal }) => {
      if (!term.info.running) return
      // node-pty reports 0 for a process ended by a signal: that is not a success.
      const exitCode = signal ? 128 + signal : code
      clearTimeout(term.killTimer)
      term.info = { ...term.info, running: false, exitCode }
      this.emit('exit', { id, exitCode })
    })
    return id
  }

  private append(term: Terminal, data: string): void {
    term.buffer += data
    term.lines += count(data)
    term.end += data.length
    if (term.lines > MAX_LINES) {
      const drop = term.lines - MAX_LINES
      let cut = 0
      for (let i = 0; i < drop; i++) cut = term.buffer.indexOf('\n', cut) + 1
      term.buffer = term.buffer.slice(cut)
      term.lines = MAX_LINES
    }
    this.emit('data', { id: term.info.id, data, end: term.end })
  }

  write(id: string, data: string): void {
    const term = this.terminals.get(id)
    if (!term?.info.running) return
    try {
      term.pty.write(data)
    } catch {
      // The process is gone; its exit is reported on its own.
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.terminals.get(id)
    if (!term?.info.running) return
    try {
      term.pty.resize(cols, rows)
    } catch {
      // Same: nothing to resize.
    }
  }

  /** Ends the process. The terminal stays listed, ended, until `remove`. */
  kill(id: string): void {
    const term = this.terminals.get(id)
    if (!term?.info.running) return
    try {
      term.pty.kill()
    } catch {
      // Already dead: the exit comes from the process.
    }
    // A shell running a service may outlive the hangup: nothing keeps holding its port.
    clearTimeout(term.killTimer)
    term.killTimer = setTimeout(() => this.forceKill(term), KILL_GRACE_MS)
    term.killTimer.unref()
  }

  private forceKill(term: Terminal): void {
    if (!term.info.running) return
    try {
      // The pty child leads its own process group.
      if (term.pty.pid) process.kill(-term.pty.pid, 'SIGKILL')
      else term.pty.kill('SIGKILL')
    } catch {
      // Gone meanwhile.
    }
  }

  remove(id: string): void {
    this.kill(id)
    this.terminals.delete(id)
  }

  get(id: string): TerminalInfo | undefined {
    return this.terminals.get(id)?.info
  }

  list(cwd: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => t.info.cwd === cwd).map((t) => t.info)
  }

  /** The last 2000 lines, in raw form. */
  buffer(id: string): string {
    return this.terminals.get(id)?.buffer ?? ''
  }

  /** The buffer and how many characters had been written when it was taken, to drop chunks already in it. */
  snapshot(id: string): { data: string; end: number } {
    const term = this.terminals.get(id)
    return { data: term?.buffer ?? '', end: term?.end ?? 0 }
  }

  /** A line shown in the terminal and kept in its buffer, written by Canopy and not by the process. */
  notice(id: string, text: string): void {
    const term = this.terminals.get(id)
    if (term) this.append(term, `\u001b[33m[Canopy] ${text}\u001b[0m\r\n`)
  }

  /** At quit: no grace period, a timer would not outlive the app and a service would keep running. */
  disposeAll(): void {
    for (const term of this.terminals.values()) {
      this.kill(term.info.id)
      this.forceKill(term)
    }
  }
}
