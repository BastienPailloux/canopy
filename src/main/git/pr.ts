import { execFile } from 'node:child_process'
import { currentEnv } from '../env'

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

/** gh stops at 30 by default: a repo with more would lose rows. */
const MAX_OPEN_PRS = '200'

/**
 * The branches of `repo` with an open pull request, in one gh call for all its worktrees. A fork's branch is left out:
 * its name says nothing of ours. Null when gh is missing, not logged in, or the repo has no usable remote. Never throws.
 */
export async function openPrBranches(repo: string, run: GhRunner = runGh): Promise<string[] | null> {
  try {
    const out = await run(['pr', 'list', '--state', 'open', '--limit', MAX_OPEN_PRS, '--json', 'headRefName,isCrossRepository'], repo)
    const list = JSON.parse(out) as { headRefName: string; isCrossRepository?: boolean }[]
    return Array.isArray(list) ? list.filter((p) => !p.isCrossRepository).map((p) => p.headRefName) : null
  } catch {
    return null
  }
}
