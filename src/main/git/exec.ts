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

export function git(cwd: string, args: string[], opts: { maxBuffer?: number; okCodes?: number[]; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd, env: { ...currentEnv(), GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
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
