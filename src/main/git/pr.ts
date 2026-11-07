import { execFile } from 'node:child_process'
import { currentEnv } from '../env'

/** `unavailable`: gh is missing, not logged in, or the repo has no usable remote. */
export type PrState = 'open' | 'none' | 'unavailable'

/** Runs `gh` in `cwd` and resolves its stdout. Rejects with the error, `stderr` attached when gh ran. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>

const GH_TIMEOUT_MS = 20_000

export const runGh: GhRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env: currentEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve(stdout)
    })
  })

/** Whether the branch checked out in `cwd` has an open pull request. Never throws. */
export async function prState(cwd: string, run: GhRunner = runGh): Promise<PrState> {
  try {
    const out = await run(['pr', 'view', '--json', 'state'], cwd)
    const state = (JSON.parse(out) as { state?: unknown }).state
    if (typeof state !== 'string') return 'unavailable'
    return state === 'OPEN' ? 'open' : 'none'
  } catch (e) {
    const stderr = (e as { stderr?: unknown } | null)?.stderr
    return typeof stderr === 'string' && /no pull requests? found/i.test(stderr) ? 'none' : 'unavailable'
  }
}
