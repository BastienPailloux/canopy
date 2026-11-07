import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
}

/** No hook can be found under it: git looks for `/dev/null/<hook>` and finds nothing. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

function run(cwd: string, args: string[], opts: GitOptions, extraEnv: NodeJS.ProcessEnv = {}, config: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...config, ...args],
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

const OWN_SCOPES = new Set(['local', 'worktree'])
const FILTER_PREFIX = 'filter.'

const isIncludePath = (key: string): boolean => key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))

/** Where an include in `from` points. Relative to `from`'s folder; `~/` is the home. Other forms are not resolved. */
function includeTarget(from: string, value: string): string {
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(dirname(from), value)
}

interface FilterConfig {
  env: NodeJS.ProcessEnv
  /** Every file the repo's own config was read from, or would be read from: included ones too, even missing. */
  files: string[]
  /** False when a part of the repo's config came from somewhere a file stamp cannot follow. */
  cacheable: boolean
}

/**
 * The repo's own config may name commands to run on any diff, through its `.gitattributes`. Each filter it declares
 * is blanked. Through the environment: `-c` cannot name a filter with `=` in it. By scope: `--local` skips included files.
 */
async function readFilterConfig(cwd: string): Promise<FilterConfig> {
  const out = await run(cwd, ['config', '--list', '--show-scope', '--show-origin', '-z'], { okCodes: [1] })
  const fields = out.split('\0')
  const names = new Set<string>()
  const files = new Set<string>()
  let cacheable = true
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [scope, origin, entry] = [fields[i], fields[i + 1], fields[i + 2]]
    if (!OWN_SCOPES.has(scope)) continue
    const cut = entry.indexOf('\n')
    const key = cut < 0 ? entry : entry.slice(0, cut)
    const file = origin.startsWith('file:') ? resolve(cwd, origin.slice('file:'.length)) : undefined
    if (file === undefined) cacheable = false
    else {
      files.add(file)
      if (cut >= 0 && isIncludePath(key)) files.add(includeTarget(file, entry.slice(cut + 1)))
    }
    const end = key.lastIndexOf('.')
    if (!key.startsWith(FILTER_PREFIX) || end < FILTER_PREFIX.length) continue
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
  const env = blank.length === 0 ? {} : Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(blank.length)],
    ...blank.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])
  ])
  return { env, files: [...files], cacheable }
}

interface Blanked { files: string[]; stamp: string; env: NodeJS.ProcessEnv }

const blanked = new Map<string, Blanked>()

/**
 * The files git starts from in `cwd`: the repo's config, the worktree's own, its HEAD for an `includeIf onbranch`,
 * and the `.git` that says where they are. Null when git cannot say.
 */
async function baseFiles(cwd: string): Promise<string[] | null> {
  const out = await run(cwd, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], {}).catch(() => null)
  if (out === null) return null
  const [own, common, top] = out.split('\n').map((p) => resolve(cwd, p))
  return [join(common, 'config'), join(own, 'config.worktree'), join(own, 'HEAD'), join(top, '.git')]
}

/** Missing is a state like any other. Any other failure to state a file: null, so nothing is reused. */
async function stampOf(files: string[]): Promise<string | null> {
  const stamps = await Promise.all(files.map((file) => stat(file, { bigint: true }).then(
    (s) => (s.isDirectory() ? `d:${s.dev}:${s.ino}` : `f:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`),
    (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? 'none' : null)
  )))
  return stamps.includes(null) ? null : files.map((f, i) => `${f}\0${stamps[i]}`).join('\0')
}

const READ_ATTEMPTS = 3

/**
 * The blanking env, read again whenever any file the repo's config came from, or could come from, changed.
 * Stamped before the read, over every file it then reports: a change during it makes the next call read again.
 */
async function blankFilters(cwd: string): Promise<NodeJS.ProcessEnv> {
  const entry = blanked.get(cwd)
  if (entry) {
    const stamp = await stampOf(entry.files)
    if (stamp !== null && stamp === entry.stamp) return entry.env
    blanked.delete(cwd)
  }
  const base = await baseFiles(cwd)
  // Outside a repo, or where git cannot say: read every time.
  if (base === null) return (await readFilterConfig(cwd)).env
  let files = [...new Set([...base, ...(entry?.files ?? [])])]
  let read: FilterConfig | undefined
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const stamp = await stampOf(files)
    read = await readFilterConfig(cwd)
    if (stamp === null || !read.cacheable) return read.env
    const needed = [...new Set([...base, ...read.files])]
    if (needed.every((f) => files.includes(f))) {
      blanked.set(cwd, { files, stamp, env: read.env })
      return read.env
    }
    files = needed
  }
  return read!.env
}

/** Forgets what the repos' config declared. */
export function clearGitConfigCache(): void {
  blanked.clear()
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  if (opts.trusted) return run(cwd, args, opts)
  return run(cwd, args, opts, await blankFilters(cwd), NO_HOOKS)
}
