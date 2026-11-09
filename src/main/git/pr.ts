import { execFile } from 'node:child_process'
import { currentEnv } from '../env'

/**
 * Runs `gh` in `cwd` and resolves its stdout. `input` goes to the child's stdin: how user text (bodies, comments)
 * reaches gh without ever being an argument. Rejects with the error, `stderr` attached when gh ran.
 */
export type GhRunner = (args: string[], cwd: string, input?: string) => Promise<string>

const GH_TIMEOUT_MS = 20_000
// A PR read (100 threads of 50 comments, diff hunks included) is well past execFile's default of 1 MB.
const GH_MAX_BUFFER = 32 * 1024 * 1024

/** A runner for `bin`: `gh` in the app, any command in tests. */
export function runWith(bin: string): GhRunner {
  return (args, cwd, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(bin, args, { cwd, env: currentEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }))
        else resolve(stdout)
      })
      // Without input, close stdin anyway: gh would otherwise wait on it for `-` arguments.
      child.stdin?.on('error', () => { /* the child exited first: its own error reports it */ })
      child.stdin?.end(input ?? '')
    })
}

export const runGh: GhRunner = runWith('gh')

/** gh stops at 30 by default: a repo with more would lose rows. */
const MAX_PRS = '200'

/**
 * The branches of `repo` with an open pull request, in one gh call for all its worktrees. A fork's branch is left out:
 * its name says nothing of ours. Null when gh is missing, not logged in, or the repo has no usable remote. Never throws.
 */
export async function openPrBranches(repo: string, run: GhRunner = runGh): Promise<string[] | null> {
  try {
    const out = await run(['pr', 'list', '--state', 'open', '--limit', MAX_PRS, '--json', 'headRefName,isCrossRepository'], repo)
    const list = JSON.parse(out) as { headRefName: string; isCrossRepository?: boolean }[]
    return Array.isArray(list) ? list.filter((p) => !p.isCrossRepository).map((p) => p.headRefName) : null
  } catch {
    return null
  }
}

/** The state of a branch's latest pull request. */
export type BranchPrState = 'open' | 'merged' | 'closed'

const PR_STATES: Record<string, BranchPrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/**
 * The state of the latest PR (highest number, the one `gh pr list --head` returns first) of every branch of `repo`,
 * any state, in one gh call; forks left out. Null when gh fails or answers something else. Never throws.
 */
export async function branchPrStates(repo: string, run: GhRunner = runGh): Promise<Map<string, BranchPrState> | null> {
  try {
    const out = await run(['pr', 'list', '--state', 'all', '--limit', MAX_PRS, '--json', 'number,headRefName,state,isCrossRepository'], repo)
    const list = JSON.parse(out) as { number: number; headRefName: string; state: string; isCrossRepository?: boolean }[]
    if (!Array.isArray(list)) return null
    const latest = new Map<string, { state: BranchPrState; number: number }>()
    for (const p of list) {
      const state = PR_STATES[p.state]
      if (p.isCrossRepository || !state) continue
      const seen = latest.get(p.headRefName)
      if (!seen || p.number > seen.number) latest.set(p.headRefName, { state, number: p.number })
    }
    return new Map([...latest].map(([b, v]) => [b, v.state]))
  } catch {
    return null
  }
}
