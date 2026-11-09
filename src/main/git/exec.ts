import { execFile } from 'node:child_process'
import { currentEnv } from '../env'

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: number | string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/** A repo's own config may name a command here: git would run it on a mere `status`. */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false']

interface GitOptions {
  maxBuffer?: number
  okCodes?: number[]
  input?: string
  /**
   * The user approved this repo's config: its filters and hooks may run, as a checkout needs them to write the right files.
   * Otherwise both are suppressed.
   */
  trusted?: boolean
  /** Merged after the default environment, so it overrides it. */
  env?: NodeJS.ProcessEnv
  /** The command is killed past this delay. */
  timeoutMs?: number
}

/** No hook can be found under it: git looks for `/dev/null/<hook>` and finds nothing. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

function run(cwd: string, args: string[], opts: GitOptions, extraEnv: NodeJS.ProcessEnv = {}, config: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...config, ...args],
      { cwd, env: { ...currentEnv(), GIT_OPTIONAL_LOCKS: '0', ...extraEnv, ...opts.env },
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException
          if (typeof e.code === 'number' && opts.okCodes?.includes(e.code)) {
            resolve(stdout)
            return
          }
          reject(new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || e.message}`, stderr, e.code))
          return
        }
        resolve(stdout)
      }
    )
    if (opts.input !== undefined) {
      // A command may exit before reading everything; its exit code already reports the failure.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.input)
    }
  })
}

const OWN_SCOPES = new Set(['local', 'worktree'])
const FILTER_PREFIX = 'filter.'

/**
 * The repo's own config may name commands to run on any diff, through its `.gitattributes`. Each filter it declares
 * is blanked. Through the environment: `-c` cannot name a filter with `=` in it. By scope: `--local` skips included files.
 * Read again before every command: whatever the repo's config became since, through any file, is seen.
 */
async function blankFilters(cwd: string): Promise<NodeJS.ProcessEnv> {
  const out = await run(cwd, ['config', '--list', '--show-scope', '--name-only', '-z'], { okCodes: [1] })
  const fields = out.split('\0')
  const names = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i + 1]
    const end = key.lastIndexOf('.')
    if (!OWN_SCOPES.has(fields[i]) || !key.startsWith(FILTER_PREFIX) || end < FILTER_PREFIX.length) continue
    const name = key.slice(FILTER_PREFIX.length, end)
    // Its bytes are lost in decoding: it could not be blanked, and would run.
    if (name.includes('\uFFFD')) throw new GitError('A filter of this repo has an unreadable name', '')
    names.add(name)
  }
  const blank = [...names].flatMap((name) => [
    [`filter.${name}.clean`, ''], [`filter.${name}.smudge`, ''], [`filter.${name}.process`, ''],
    // A required filter with nothing to run fails the command.
    [`filter.${name}.required`, 'false']
  ])
  if (blank.length === 0) return {}
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(blank.length)],
    ...blank.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])
  ])
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  if (opts.trusted) return run(cwd, args, opts)
  return run(cwd, args, opts, await blankFilters(cwd), NO_HOOKS)
}
