import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Runs the user's login shell and returns the raw stdout of the env dump. */
export type ShellRunner = () => Promise<string>

const START = '__CANOPY_ENV_START__'
const END = '__CANOPY_ENV_END__'
/** A login shell with pyenv, brew shellenv and the like can take minutes: it runs in the background. */
const TIMEOUT_MS = 180_000

const defaultRunner: ShellRunner = () =>
  new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/zsh'
    // stdin ignored: an interactive shell must not wait for a terminal.
    const child = spawn(shell, ['-ilc', `printf '%s\\n' ${START}; env; printf '%s\\n' ${END}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL'
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`login shell exited with ${code}`))))
  })

function parse(output: string): Record<string, string> {
  const start = output.indexOf(START)
  const end = output.lastIndexOf(END)
  if (start === -1 || end === -1 || end < start) return {}
  const body = output.slice(start + START.length, end)
  const vars: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) vars[m[1]] = m[2]
  }
  return vars
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('login shell timeout')), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

const sanitize = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env }
  delete copy.ELECTRON_RUN_AS_NODE
  return copy
}

/** The env of the login shell merged over process.env, and whether the shell answered. */
async function resolveShellEnv(run: ShellRunner, timeoutMs: number): Promise<{ env: NodeJS.ProcessEnv; ok: boolean }> {
  try {
    const shellEnv = parse(await withTimeout(run(), timeoutMs))
    return { env: sanitize({ ...process.env, ...shellEnv }), ok: Object.keys(shellEnv).length > 0 }
  } catch {
    return { env: sanitize(process.env), ok: false }
  }
}

let cached: Promise<NodeJS.ProcessEnv> | undefined

export function resetLoginShellEnvCache(): void {
  cached = undefined
}

/** process.env merged with the login shell env, without ELECTRON_RUN_AS_NODE. Cached. Process.env alone on failure or timeout. */
export function loginShellEnv(run: ShellRunner = defaultRunner, timeoutMs = TIMEOUT_MS): Promise<NodeJS.ProcessEnv> {
  cached ??= resolveShellEnv(run, timeoutMs).then((r) => r.env)
  return cached
}

let current: NodeJS.ProcessEnv | undefined

/** The env for processes started now (git, sessions, terminals, language servers): the best one known so far. */
export function currentEnv(): NodeJS.ProcessEnv {
  return current ?? sanitize(process.env)
}

export function resetCurrentEnv(): void {
  current = undefined
}

export interface FallbackPathOptions {
  home?: string
  path?: string
  exists?: (dir: string) => boolean
  /** Names inside a directory. */
  readdir?: (dir: string) => string[]
}

const versionParts = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
const compareVersions = (a: string, b: string): number => {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** The PATH of an app started from the Finder, plus the usual tool directories that exist on this machine. */
export function fallbackPath(o: FallbackPathOptions = {}): string {
  const home = o.home ?? homedir()
  const exists = o.exists ?? existsSync
  const readdir = o.readdir ?? ((d: string) => { try { return readdirSync(d) } catch { return [] } })
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  const newest = readdir(nvmRoot).sort(compareVersions).at(-1)
  const candidates = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(home, '.local', 'bin'),
    ...(newest ? [join(nvmRoot, newest, 'bin')] : []),
    join(home, '.volta', 'bin'), join(home, '.pyenv', 'shims')
  ]
  const base = (o.path ?? process.env.PATH ?? '').split(':').filter((d) => d !== '')
  return [...new Set([...candidates.filter((d) => exists(d)), ...base])].join(':')
}

export interface StartEnvOptions extends FallbackPathOptions {
  /** PATH of the last login shell that resolved. */
  persistedPath?: string
  /** Called with the resolved env, once, if the login shell answered. */
  onResolved: (env: NodeJS.ProcessEnv) => void
  run?: ShellRunner
  timeoutMs?: number
}

/**
 * Sets a usable env now (the persisted PATH, else a fallback) and resolves the login shell in the background.
 * When it answers, its env replaces it for the processes started after. Never blocks.
 */
export function startEnv(o: StartEnvOptions): void {
  current = sanitize({ ...process.env, PATH: o.persistedPath ?? fallbackPath(o) })
  void resolveShellEnv(o.run ?? defaultRunner, o.timeoutMs ?? TIMEOUT_MS).then(({ env, ok }) => {
    if (!ok) return
    current = env
    o.onResolved(env)
  })
}
