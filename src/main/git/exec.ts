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

export function git(cwd: string, args: string[], opts: { maxBuffer?: number; okCodes?: number[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
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
  })
}
