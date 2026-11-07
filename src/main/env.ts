import { execFile } from 'node:child_process'

/** Runs the user's login shell and returns the raw stdout of the env dump. */
export type ShellRunner = () => Promise<string>

const START = '__CANOPY_ENV_START__'
const END = '__CANOPY_ENV_END__'
const TIMEOUT_MS = 5000

const defaultRunner: ShellRunner = () =>
  new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(
      shell,
      ['-ilc', `printf '%s\\n' ${START}; env; printf '%s\\n' ${END}`],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
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

let cached: Promise<NodeJS.ProcessEnv> | undefined

export function resetLoginShellEnvCache(): void {
  cached = undefined
}

/** process.env merged with the login shell env, without ELECTRON_RUN_AS_NODE. Cached. */
export function loginShellEnv(run: ShellRunner = defaultRunner): Promise<NodeJS.ProcessEnv> {
  cached ??= (async () => {
    let shellEnv: Record<string, string> = {}
    try {
      shellEnv = parse(await withTimeout(run(), TIMEOUT_MS))
    } catch {
      // fall back to process.env
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...shellEnv }
    delete env.ELECTRON_RUN_AS_NODE
    return env
  })()
  return cached
}
