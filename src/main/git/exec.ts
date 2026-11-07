import { execFile } from 'node:child_process'
import { currentEnv } from '../env'
import { TtlCache } from './ttlCache'

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
  /** For a checkout the user asked for: without the repo's filters its files would be wrong. Its hooks run anyway. */
  keepFilters?: boolean
}

function run(cwd: string, args: string[], opts: GitOptions, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd, env: { ...currentEnv(), GIT_OPTIONAL_LOCKS: '0', ...extraEnv }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
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

const FILTERS_TTL_MS = 5_000
const OWN_SCOPES = new Set(['local', 'worktree'])

/**
 * The repo's own config may name commands to run on any diff, through its `.gitattributes`. Each filter it declares
 * is blanked. Through the environment: `-c` cannot name a filter with `=` in it. By scope: `--local` skips included files.
 */
async function readBlankFilters(cwd: string): Promise<NodeJS.ProcessEnv> {
  const out = await run(cwd, ['config', '--show-scope', '--name-only', '-z', '--get-regexp', '^filter\\.'], { okCodes: [1] })
  const fields = out.split('\0')
  const names = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const name = /^filter\.(.*)\.[^.]+$/.exec(fields[i + 1])?.[1]
    if (name !== undefined && OWN_SCOPES.has(fields[i])) names.add(name)
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

const blankFilters = new TtlCache<NodeJS.ProcessEnv>(FILTERS_TTL_MS)

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return run(cwd, args, opts, opts.keepFilters ? {} : await blankFilters.get(cwd, () => readBlankFilters(cwd)))
}
