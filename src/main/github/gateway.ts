import type { PrOptions, PrState, PrSummary, PrDetail } from '../../shared/pr'
import { branchPrStates, runGh, type BranchPrState, type GhRunner } from '../git/pr'
import { PR_QUERY, isObj, parsePrDetail, unreadable, viewerOf } from './query'

/** Everything the PR tab asks GitHub. `ghGateway` in the app, a fake one in the e2e. */
export interface PrGateway {
  /** The latest PR whose head is `branch`, any state; null when there is none or it comes from a fork. */
  find(cwd: string, branch: string): Promise<PrSummary | null>
  view(cwd: string, number: number): Promise<PrDetail>
  /** What the reviewer, assignee and label pickers offer. */
  options(cwd: string, number: number): Promise<PrOptions>
  /** The end of a failed job's log: its last 20 non-empty lines. */
  failedLog(cwd: string, runId: number, jobId: number): Promise<string>
  /** The state of every branch's latest PR in the repo of `repo`; null when gh cannot tell. */
  branchStates(repo: string): Promise<Map<string, BranchPrState> | null>
}

const FAILED_LOG_LINES = 20

const OPTIONS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    owner { __typename login }
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name } }
    assignableUsers(first: 100) { nodes { login } }
    pullRequest(number: $number) { suggestedReviewers { isAuthor isCommenter reviewer { login } } }
  }
}`

// Separate: reading teams needs the read:org scope, which a token may lack. Its failure must not hide the rest.
const TEAMS_QUERY = `query($owner: String!) {
  organization(login: $owner) { teams(first: 100) { nodes { slug } } }
}`

const SUMMARY_STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** gh's own words (stderr) when it ran, else the spawn error. */
function ghError(e: unknown): Error {
  const stderr = typeof (e as { stderr?: unknown })?.stderr === 'string' ? ((e as { stderr: string }).stderr).trim() : ''
  const message = stderr || (e instanceof Error ? e.message : String(e))
  return new Error(`GitHub (gh) : ${message}`)
}

function json(out: string): unknown {
  try {
    return JSON.parse(out)
  } catch {
    throw unreadable()
  }
}

/** The real gateway: every call is one or two `gh` runs in the worktree. */
export function ghGateway(run: GhRunner = runGh): PrGateway {
  // A worktree's repo never changes: read owner and name once.
  const repos = new Map<string, Promise<{ owner: string; name: string }>>()

  const gh = async (args: string[], cwd: string): Promise<string> => {
    try {
      return await run(args, cwd)
    } catch (e) {
      throw ghError(e)
    }
  }

  const repoOf = (cwd: string): Promise<{ owner: string; name: string }> => {
    let p = repos.get(cwd)
    if (!p) {
      p = gh(['repo', 'view', '--json', 'owner,name'], cwd).then((out) => {
        const r = json(out)
        if (!isObj(r) || !isObj(r.owner) || typeof r.owner.login !== 'string' || typeof r.name !== 'string') throw unreadable()
        return { owner: r.owner.login, name: r.name }
      })
      // a failure (offline, logged out) is retried next time
      p.catch(() => repos.delete(cwd))
      repos.set(cwd, p)
    }
    return p
  }

  // -f keeps owner and name strings (-F would turn a repo named `123` into a number); the number is typed with -F.
  const graphql = async (cwd: string, query: string, fields: { number?: number } = {}): Promise<unknown> => {
    const { owner, name } = await repoOf(cwd)
    const args = ['api', 'graphql', '-f', `owner=${owner}`]
    if (fields.number !== undefined) args.push('-f', `name=${name}`, '-F', `number=${fields.number}`)
    args.push('-f', `query=${query}`)
    return json(await gh(args, cwd))
  }

  return {
    async find(cwd, branch) {
      const out = await gh(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,title,url,isCrossRepository,isDraft'], cwd)
      const list = json(out)
      if (!Array.isArray(list)) throw unreadable()
      const p = list[0]
      if (!isObj(p) || p.isCrossRepository) return null
      const state = SUMMARY_STATES[String(p.state)]
      if (typeof p.number !== 'number' || !state || typeof p.title !== 'string' || typeof p.url !== 'string') throw unreadable()
      return { number: p.number, state: state === 'open' && p.isDraft ? 'draft' : state, title: p.title, url: p.url }
    },

    async view(cwd, number) {
      const raw = await graphql(cwd, PR_QUERY, { number })
      return parsePrDetail(raw, viewerOf(raw))
    },

    async options(cwd, number) {
      const raw = await graphql(cwd, OPTIONS_QUERY, { number })
      const repo = isObj(raw) && isObj(raw.data) && isObj(raw.data.repository) ? raw.data.repository : null
      const pr = repo && isObj(repo.pullRequest) ? repo.pullRequest : null
      if (!repo || !pr || !isObj(repo.owner)) throw unreadable()
      const names = (c: unknown, key: string): string[] =>
        isObj(c) && Array.isArray(c.nodes) ? c.nodes.flatMap((n) => (isObj(n) && typeof n[key] === 'string' ? [n[key] as string] : [])) : []
      const suggested: PrOptions['suggested'] = (Array.isArray(pr.suggestedReviewers) ? pr.suggestedReviewers : []).flatMap((s) => {
        if (!isObj(s) || !isObj(s.reviewer) || typeof s.reviewer.login !== 'string') return []
        const hint = s.isAuthor ? 'A modifié ces fichiers' : s.isCommenter ? 'A commenté' : 'Suggéré par GitHub'
        return [{ login: s.reviewer.login, kind: 'user' as const, hint }]
      })
      if (repo.owner.__typename === 'Organization') {
        try {
          const teams = await graphql(cwd, TEAMS_QUERY)
          const org = isObj(teams) && isObj(teams.data) && isObj(teams.data.organization) ? teams.data.organization : null
          const owner = String(repo.owner.login)
          for (const slug of names(org?.teams, 'slug')) suggested.push({ login: `${owner}/${slug}`, kind: 'team', hint: 'Équipe' })
        } catch {
          // no read:org scope: no teams to offer, the rest still is
        }
      }
      return { labels: names(repo.labels, 'name'), assignable: names(repo.assignableUsers, 'login'), suggested }
    },

    async failedLog(cwd, runId, jobId) {
      const out = await gh(['run', 'view', String(runId), '--job', String(jobId), '--log-failed'], cwd)
      return out.split('\n').filter((l) => l.trim() !== '').slice(-FAILED_LOG_LINES).join('\n')
    },

    branchStates(repo) {
      return branchPrStates(repo, run)
    },
  }
}
