import { isCopilot, type PrAction, type PrActResult, type MergeMethod, type PrOptions, type PrState, type PrSummary, type PrDetail } from '../../shared/pr'
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
  /** Changes the PR: one `gh` run per action (two for reviewers when Copilot is among them). */
  act(cwd: string, number: number, a: PrAction): Promise<PrActResult>
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

const PR_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`

const MUTATIONS = {
  resolve: 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }',
  unresolve: 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }',
  viewed: 'mutation($id: ID!, $path: String!) { markFileAsViewed(input: {pullRequestId: $id, path: $path}) { clientMutationId } }',
  unviewed: 'mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: {pullRequestId: $id, path: $path}) { clientMutationId } }',
  revert: 'mutation($id: ID!) { revertPullRequest(input: {pullRequestId: $id}) { revertPullRequest { url } } }',
}

/** Copilot's review is requested as this bot through REST: gh 2.61's `--add-reviewer` only knows users and teams. Not verified live. */
const COPILOT_REVIEWER = 'copilot-pull-request-reviewer[bot]'
const METHOD_FLAGS: Record<MergeMethod, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' }

const SUMMARY_STATES: Record<string, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** gh's own words (stderr) when it ran, else the spawn error. */
function ghError(e: unknown): Error {
  const stderr = typeof (e as { stderr?: unknown })?.stderr === 'string' ? ((e as { stderr: string }).stderr).trim() : ''
  const message = stderr || (e instanceof Error ? e.message : String(e))
  const code = (e as { code?: unknown })?.code
  return Object.assign(new Error(`GitHub (gh) : ${message}`), typeof code === 'string' ? { code } : {})
}

// gh's words when it has no account to use, or the repo no GitHub remote to ask.
const UNAVAILABLE = /gh auth login|not logged in|GH_TOKEN|HTTP 401|Bad credentials|known GitHub host|no git remotes/i

/**
 * gh missing (ENOENT), logged out, or the repo not on GitHub: there is no PR to show, nothing went wrong.
 * Anything else (offline, GitHub down) is a failure the tab reports.
 */
export function isGhUnavailable(e: unknown): boolean {
  if ((e as { code?: unknown })?.code === 'ENOENT') return true
  return e instanceof Error && UNAVAILABLE.test(e.message)
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

  const mutate = async (cwd: string, query: string, vars: Record<string, string>): Promise<string> => {
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`)
    return gh(args, cwd)
  }

  const prNodeId = async (cwd: string, number: number): Promise<string> => {
    const raw = await graphql(cwd, PR_ID_QUERY, { number })
    const repo = isObj(raw) && isObj(raw.data) && isObj(raw.data.repository) ? raw.data.repository : null
    const pr = repo && isObj(repo.pullRequest) ? repo.pullRequest : null
    if (!pr || typeof pr.id !== 'string') throw unreadable()
    return pr.id
  }

  // `--flag=value` so a login or label starting with `-` cannot be read as a flag
  const editFlags = (kind: string, a: { add: string[]; remove: string[] }): string[] => [
    ...a.add.map((v) => `--add-${kind}=${v}`),
    ...a.remove.map((v) => `--remove-${kind}=${v}`),
  ]

  const edit = async (cwd: string, number: number, flags: string[]): Promise<void> => {
    if (flags.length > 0) await gh(['pr', 'edit', String(number), ...flags], cwd)
  }

  const copilot = async (cwd: string, number: number, method: 'POST' | 'DELETE'): Promise<void> => {
    const { owner, name } = await repoOf(cwd)
    const args = ['api', '-X', method, `repos/${owner}/${name}/pulls/${number}/requested_reviewers`, '--input', '-']
    try {
      await run(args, cwd, JSON.stringify({ reviewers: [COPILOT_REVIEWER] }))
    } catch (e) {
      throw ghError(e)
    }
  }

  // Bodies and the bot payload go through stdin: user text never lands in an argument.
  const withInput = async (args: string[], cwd: string, input: string): Promise<void> => {
    try {
      await run(args, cwd, input)
    } catch (e) {
      throw ghError(e)
    }
  }

  return {
    async act(cwd, number, a) {
      const n = String(number)
      switch (a.type) {
        case 'comment':
          await withInput(['pr', 'comment', n, '--body-file', '-'], cwd, a.body)
          break
        case 'reply': {
          const { owner, name } = await repoOf(cwd)
          await withInput(['api', '-X', 'POST', `repos/${owner}/${name}/pulls/${n}/comments/${a.commentId}/replies`, '-F', 'body=@-'], cwd, a.body)
          break
        }
        case 'resolve':
          await mutate(cwd, a.resolved ? MUTATIONS.resolve : MUTATIONS.unresolve, { id: a.threadId })
          break
        case 'review':
          await withInput(['pr', 'review', n, a.event === 'APPROVE' ? '--approve' : '--request-changes', '--body-file', '-'], cwd, a.body)
          break
        case 'editBody':
          await withInput(['pr', 'edit', n, '--body-file', '-'], cwd, a.body)
          break
        case 'draft':
          await gh(a.draft ? ['pr', 'ready', n, '--undo'] : ['pr', 'ready', n], cwd)
          break
        case 'close':
          await gh(['pr', 'close', n], cwd)
          break
        case 'reopen':
          await gh(['pr', 'reopen', n], cwd)
          break
        case 'reviewers': {
          await edit(cwd, number, editFlags('reviewer', { add: a.add.filter((l) => !isCopilot(l)), remove: a.remove.filter((l) => !isCopilot(l)) }))
          if (a.add.some(isCopilot)) await copilot(cwd, number, 'POST')
          if (a.remove.some(isCopilot)) await copilot(cwd, number, 'DELETE')
          break
        }
        case 'assignees':
          await edit(cwd, number, editFlags('assignee', a))
          break
        case 'labels':
          await edit(cwd, number, editFlags('label', a))
          break
        case 'viewed':
          await mutate(cwd, a.viewed ? MUTATIONS.viewed : MUTATIONS.unviewed, { id: await prNodeId(cwd, number), path: a.path })
          break
        case 'rerun':
          await gh(['run', 'rerun', String(a.runId), ...(a.jobId === null ? ['--failed'] : ['--job', String(a.jobId)])], cwd)
          break
        case 'updateBranch':
          await gh(['pr', 'update-branch', n], cwd)
          break
        case 'merge':
        case 'autoMerge': {
          if (a.type === 'autoMerge' && !a.enable) {
            await gh(['pr', 'merge', n, '--disable-auto'], cwd)
            break
          }
          // Only at the head shown: a commit pushed since is not merged unseen.
          const args = ['pr', 'merge', n, ...(a.type === 'autoMerge' ? ['--auto'] : []), METHOD_FLAGS[a.method], `--match-head-commit=${a.headOid}`]
          // A rebase replays the commits as they are: gh refuses a subject or a body for it.
          if (a.method === 'rebase') await gh(args, cwd)
          else await withInput([...args, `--subject=${a.subject}`, '--body-file', '-'], cwd, a.body)
          break
        }
        case 'revert': {
          const raw = json(await mutate(cwd, MUTATIONS.revert, { id: await prNodeId(cwd, number) }))
          const data = isObj(raw) && isObj(raw.data) ? raw.data : null
          const outer = data && isObj(data.revertPullRequest) ? data.revertPullRequest : null
          const pr = outer && isObj(outer.revertPullRequest) ? outer.revertPullRequest : null
          if (!pr || typeof pr.url !== 'string') throw unreadable()
          return { ok: true, url: pr.url }
        }
        case 'deleteRemoteBranch': {
          if (a.branch === '') throw new Error('Nom de branche vide')
          const { owner, name } = await repoOf(cwd)
          await gh(['api', '-X', 'DELETE', `repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(a.branch)}`], cwd)
          break
        }
      }
      return { ok: true }
    },

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
