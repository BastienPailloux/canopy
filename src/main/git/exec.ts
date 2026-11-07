import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

/**
 * The repo's own config may name commands to run on any diff, through its `.gitattributes`. Each filter it declares
 * is blanked. Through the environment: `-c` cannot name a filter with `=` in it. By scope: `--local` skips included files.
 */
async function readBlankFilters(cwd: string): Promise<NodeJS.ProcessEnv> {
  const out = await run(cwd, ['config', '--show-scope', '--name-only', '-z', '--get-regexp', '^filter\\.'], { okCodes: [1] })
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

interface GitPaths { common: string; own: string }
interface Blanked { stamp: string; env: Promise<NodeJS.ProcessEnv> }

const paths = new Map<string, Promise<GitPaths | null>>()
const blanked = new Map<string, Blanked>()

/** Where `cwd`'s config lives. Null outside a repo: there is no repo config to blank. Not kept if it fails. */
function gitPaths(cwd: string): Promise<GitPaths | null> {
  let found = paths.get(cwd)
  if (!found) {
    found = run(cwd, ['rev-parse', '--git-dir', '--git-common-dir'], {}).then((out) => {
      const [own, common] = out.split('\n')
      return { own: resolve(cwd, own), common: resolve(cwd, common) }
    }, () => null)
    paths.set(cwd, found)
    void found.then((p) => { if (p === null && paths.get(cwd) === found) paths.delete(cwd) })
  }
  return found
}

const fileStamp = (file: string): Promise<string> =>
  stat(file, { bigint: true }).then((s) => `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, () => 'none')

/**
 * What the effective filters depend on: the repo's config, the worktree's own, and its HEAD for an `includeIf onbranch`.
 * Files they include are not watched.
 */
async function configStamp(p: GitPaths): Promise<string> {
  return (await Promise.all([join(p.common, 'config'), join(p.own, 'config.worktree'), join(p.own, 'HEAD')].map(fileStamp))).join('|')
}

/** The blanking env, read again whenever a file it depends on changed. A failure is not kept. */
async function blankFilters(cwd: string): Promise<NodeJS.ProcessEnv> {
  let p = await gitPaths(cwd)
  if (p === null) return {}
  let stamp = await configStamp(p)
  // No HEAD where it was: the worktree moved, or was made again elsewhere.
  if (stamp.endsWith('|none')) {
    paths.delete(cwd)
    p = await gitPaths(cwd)
    if (p === null) return {}
    stamp = await configStamp(p)
  }
  const entry = blanked.get(cwd)
  if (entry && entry.stamp === stamp) return entry.env
  // Stamped before the read: a change during it makes the next call read again.
  const fresh = { stamp, env: readBlankFilters(cwd) }
  blanked.set(cwd, fresh)
  fresh.env.catch(() => { if (blanked.get(cwd) === fresh) blanked.delete(cwd) })
  return fresh.env
}

/** Forgets where repos keep their config, and what it declared. */
export function clearGitConfigCache(): void {
  paths.clear()
  blanked.clear()
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  if (opts.trusted) return run(cwd, args, opts)
  return run(cwd, args, opts, await blankFilters(cwd), NO_HOOKS)
}
