import { execFile } from 'node:child_process'

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

let gitEnv: NodeJS.ProcessEnv | undefined

/** Set the environment used for every git call (the login shell env, set once at startup). */
export function setGitEnv(env: NodeJS.ProcessEnv | undefined): void {
  gitEnv = env
}

export function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: gitEnv ?? process.env, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException
          reject(new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || e.message}`, stderr, e.code))
          return
        }
        resolve(stdout)
      }
    )
  })
}
