import type { CheckOutcome, MergeMethod, PrComment, PrCommit, PrCheck, PrDetail, PrFile, PrReviewState, PrReviewer, PrState, PrThread, PrTimelineItem, PrUser } from '../../shared/pr'

/** The one read of the PR tab. Every connection stops at 100: `truncated` says how many more GitHub has. */
export const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    owner { login }
    name
    squashMergeAllowed
    mergeCommitAllowed
    rebaseMergeAllowed
    autoMergeAllowed
    pullRequest(number: $number) {
      id
      number
      url
      title
      body
      state
      isDraft
      createdAt
      baseRefName
      headRefName
      headRefOid
      additions
      deletions
      reviewDecision
      mergeStateStatus
      autoMergeRequest { enabledAt }
      author { __typename login }
      assignees(first: 100) { nodes { login } }
      labels(first: 100) { nodes { name } }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Bot { login }
            ... on Mannequin { login }
            ... on Team { slug organization { login } }
          }
        }
      }
      latestReviews(first: 100) { nodes { state author { __typename login } } }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id
          path
          line
          startLine
          isResolved
          isOutdated
          comments(first: 50) { nodes { id databaseId body createdAt diffHunk author { __typename login } } }
        }
      }
      timelineItems(first: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT]) {
        filteredCount
        nodes {
          __typename
          ... on IssueComment { id databaseId body createdAt author { __typename login } }
          ... on PullRequestReview { state body createdAt submittedAt author { __typename login } }
          ... on PullRequestCommit { commit { oid committedDate author { name user { login } } } }
        }
      }
      commits(last: 100) {
        totalCount
        nodes {
          commit {
            oid
            message
            committedDate
            author { name user { login } }
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    title
                    status
                    conclusion
                    startedAt
                    completedAt
                    detailsUrl
                    checkSuite { app { name } workflowRun { databaseId workflow { name } } }
                  }
                  ... on StatusContext { context description state targetUrl }
                }
              }
            }
          }
        }
      }
      files(first: 100) { totalCount nodes { path changeType additions deletions viewerViewedState } }
    }
  }
}
`

/** GitHub answered something this parser does not know: a schema change, or not GitHub at all. */
const unreadable = (): Error => new Error('Réponse GitHub illisible')

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function obj(v: unknown): Obj {
  if (!isObj(v)) throw unreadable()
  return v
}
function str(o: Obj, key: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw unreadable()
  return v
}
function optStr(o: Obj, key: string): string | null {
  const v = o[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw unreadable()
  return v
}
function int(o: Obj, key: string): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) throw unreadable()
  return v
}
function optInt(o: Obj, key: string): number | null {
  return o[key] === null || o[key] === undefined ? null : int(o, key)
}
function bool(o: Obj, key: string): boolean {
  const v = o[key]
  if (typeof v !== 'boolean') throw unreadable()
  return v
}
function nodes(o: Obj, key: string): Obj[] {
  const c = obj(o[key])
  if (!Array.isArray(c.nodes)) throw unreadable()
  // GitHub leaves a null node for an item the token cannot see.
  return c.nodes.filter((n) => n !== null).map(obj)
}
/** How many items of the connection `key` GitHub did not send. */
function rest(o: Obj, key: string, countKey = 'totalCount'): number {
  return Math.max(0, int(obj(o[key]), countKey) - nodes(o, key).length)
}

/** An `Actor`; null is a deleted account, which GitHub itself shows as `ghost`. */
function user(v: unknown): PrUser {
  if (v === null || v === undefined) return { login: 'ghost', bot: false }
  const o = obj(v)
  return { login: str(o, 'login'), bot: o.__typename === 'Bot' }
}

/** The login of a commit's author, or the name git recorded when no GitHub account matches. */
function gitActor(v: unknown): string {
  if (v === null || v === undefined) return 'ghost'
  const o = obj(v)
  if (isObj(o.user) && typeof o.user.login === 'string') return o.user.login
  return optStr(o, 'name') ?? 'ghost'
}

const ROLLUP: Record<string, CheckOutcome> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' }
const CONCLUSION: Record<string, CheckOutcome> = {
  SUCCESS: 'success', FAILURE: 'failure', TIMED_OUT: 'failure', CANCELLED: 'failure', ACTION_REQUIRED: 'failure', STARTUP_FAILURE: 'failure',
  NEUTRAL: 'neutral', SKIPPED: 'neutral', STALE: 'neutral',
}

function rollupOutcome(v: unknown): CheckOutcome | null {
  if (v === null || v === undefined) return null
  return ROLLUP[str(obj(v), 'state')] ?? 'pending'
}

function comment(o: Obj): PrComment {
  return { id: str(o, 'id'), databaseId: int(o, 'databaseId'), author: user(o.author), body: str(o, 'body'), createdAt: str(o, 'createdAt') }
}

function thread(o: Obj): PrThread {
  const comments = nodes(o, 'comments')
  if (comments.length === 0) throw unreadable()
  return {
    id: str(o, 'id'),
    path: str(o, 'path'),
    line: optInt(o, 'line'),
    startLine: optInt(o, 'startLine'),
    // GitHub keeps the hunk on each comment: the first one anchors the thread.
    diffHunk: str(comments[0], 'diffHunk'),
    resolved: bool(o, 'isResolved'),
    outdated: bool(o, 'isOutdated'),
    comments: comments.map(comment),
  }
}

const REVIEW_STATES: PrReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']

/** Comments, reviews and pushes in GitHub's order; consecutive commits of one author are one push, dated by its last. */
function events(items: Obj[]): PrTimelineItem[] {
  const out: PrTimelineItem[] = []
  for (const n of items) {
    switch (n.__typename) {
      case 'IssueComment': {
        const c = comment(n)
        out.push({ kind: 'comment', at: c.createdAt, comment: c })
        break
      }
      case 'PullRequestReview': {
        const state = str(n, 'state') as PrReviewState
        const body = str(n, 'body')
        // PENDING is the viewer's unsent draft; a bodiless comment review is only the envelope of its threads.
        if (!REVIEW_STATES.includes(state) || (state === 'COMMENTED' && body.trim() === '')) break
        out.push({ kind: 'review', at: optStr(n, 'submittedAt') ?? str(n, 'createdAt'), author: user(n.author), state, body })
        break
      }
      case 'PullRequestCommit': {
        const c = obj(n.commit)
        const login = gitActor(c.author)
        const at = str(c, 'committedDate')
        const last = out[out.length - 1]
        if (last?.kind === 'push' && last.author.login === login) {
          last.count++
          last.at = at
        } else out.push({ kind: 'push', at, author: { login, bot: login.endsWith('[bot]') }, count: 1 })
        break
      }
      default:
        throw unreadable()
    }
  }
  return out
}

function check(n: Obj): PrCheck {
  if (n.__typename === 'StatusContext') {
    return { name: str(n, 'context'), detail: optStr(n, 'description') ?? '', outcome: ROLLUP[str(n, 'state')] ?? 'pending', durationMs: null, url: optStr(n, 'targetUrl'), run: null }
  }
  if (n.__typename !== 'CheckRun') throw unreadable()
  const suite = isObj(n.checkSuite) ? n.checkSuite : {}
  const workflowRun = isObj(suite.workflowRun) ? suite.workflowRun : null
  const workflow = workflowRun && isObj(workflowRun.workflow) ? optStr(workflowRun.workflow, 'name') : null
  const app = isObj(suite.app) ? optStr(suite.app, 'name') : null
  const started = optStr(n, 'startedAt')
  const completed = optStr(n, 'completedAt')
  const conclusion = optStr(n, 'conclusion')
  return {
    name: str(n, 'name'),
    detail: workflow ?? optStr(n, 'title') ?? app ?? '',
    outcome: str(n, 'status') === 'COMPLETED' && conclusion ? CONCLUSION[conclusion] ?? 'neutral' : 'pending',
    durationMs: started && completed ? Date.parse(completed) - Date.parse(started) : null,
    url: optStr(n, 'detailsUrl'),
    run: workflowRun ? { runId: int(workflowRun, 'databaseId'), jobId: int(n, 'databaseId') } : null,
  }
}

const CHANGE: Record<string, PrFile['change']> = { ADDED: 'A', COPIED: 'A', MODIFIED: 'M', CHANGED: 'M', DELETED: 'D', RENAMED: 'R' }

/** Requested reviewers first (pending, even after an earlier review), then the latest review of everyone else but the author. */
function reviewers(pr: Obj, author: string): PrReviewer[] {
  const out: PrReviewer[] = []
  for (const r of nodes(pr, 'reviewRequests')) {
    const who = r.requestedReviewer
    // null: a reviewer the token cannot see
    if (!isObj(who)) continue
    if (who.__typename === 'Team') out.push({ login: `${str(obj(who.organization), 'login')}/${str(who, 'slug')}`, kind: 'team', status: 'pending' })
    else if (who.__typename === 'User' || who.__typename === 'Bot') out.push({ login: str(who, 'login'), kind: who.__typename === 'Bot' ? 'bot' : 'user', status: 'pending' })
  }
  const STATUS: Record<string, PrReviewer['status']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' }
  for (const r of nodes(pr, 'latestReviews')) {
    const who = user(r.author)
    const status = STATUS[str(r, 'state')]
    if (!status || who.login === author || out.some((o) => o.login === who.login)) continue
    out.push({ login: who.login, kind: who.bot ? 'bot' : 'user', status })
  }
  return out
}

const DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const
const MERGE_STATES = ['CLEAN', 'BLOCKED', 'BEHIND', 'DIRTY', 'UNSTABLE', 'HAS_HOOKS', 'DRAFT', 'UNKNOWN'] as const

function prState(pr: Obj): PrState {
  switch (str(pr, 'state')) {
    case 'OPEN': return bool(pr, 'isDraft') ? 'draft' : 'open'
    case 'MERGED': return 'merged'
    case 'CLOSED': return 'closed'
    default: throw unreadable()
  }
}

/** `gh api graphql` output for {@link PR_QUERY}, as the PR tab shows it. Throws « Réponse GitHub illisible » on any other shape. */
export function parsePrDetail(raw: unknown, viewerLogin: string): PrDetail {
  const repo = obj(obj(obj(raw).data).repository)
  const pr = obj(repo.pullRequest)
  const author = user(pr.author)

  const commitNodes = nodes(pr, 'commits').map((n) => obj(n.commit))
  const commits: PrCommit[] = commitNodes.map((c) => ({
    oid: str(c, 'oid'), message: str(c, 'message'), author: gitActor(c.author), at: str(c, 'committedDate'), outcome: rollupOutcome(c.statusCheckRollup),
  }))

  const lastCommit = commitNodes[commitNodes.length - 1]
  const rollup = lastCommit && isObj(lastCommit.statusCheckRollup) ? lastCommit.statusCheckRollup : null
  const checks = rollup ? nodes(rollup, 'contexts').map(check) : []

  const threads = nodes(pr, 'reviewThreads').map(thread)
  const timeline: PrTimelineItem[] = [
    ...events(nodes(pr, 'timelineItems')),
    ...threads.map((t): PrTimelineItem => ({ kind: 'thread', at: t.comments[0].createdAt, thread: t })),
  ]
  const ci = rollupOutcome(rollup)
  if (lastCommit && ci) timeline.push({ kind: 'ci', at: str(lastCommit, 'committedDate'), sha: str(lastCommit, 'oid'), outcome: ci })
  // ISO dates of one format compare as strings; the sort is stable, so GitHub's order holds within a second.
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  const decision = optStr(pr, 'reviewDecision')
  const mergeState = str(pr, 'mergeStateStatus')
  const methods: MergeMethod[] = []
  if (bool(repo, 'squashMergeAllowed')) methods.push('squash')
  if (bool(repo, 'mergeCommitAllowed')) methods.push('merge')
  if (bool(repo, 'rebaseMergeAllowed')) methods.push('rebase')

  return {
    number: int(pr, 'number'),
    url: str(pr, 'url'),
    title: str(pr, 'title'),
    body: str(pr, 'body'),
    state: prState(pr),
    author,
    createdAt: str(pr, 'createdAt'),
    base: str(pr, 'baseRefName'),
    head: str(pr, 'headRefName'),
    headOid: str(pr, 'headRefOid'),
    additions: int(pr, 'additions'),
    deletions: int(pr, 'deletions'),
    viewerIsAuthor: author.login === viewerLogin,
    viewerLogin,
    timeline,
    commits,
    checks,
    files: nodes(pr, 'files').map((f) => ({
      path: str(f, 'path'),
      change: CHANGE[str(f, 'changeType')] ?? 'M',
      additions: int(f, 'additions'),
      deletions: int(f, 'deletions'),
      viewed: f.viewerViewedState === 'VIEWED',
    })),
    reviewers: reviewers(pr, author.login),
    assignees: nodes(pr, 'assignees').map((a) => str(a, 'login')),
    labels: nodes(pr, 'labels').map((l) => str(l, 'name')),
    reviewDecision: DECISIONS.find((d) => d === decision) ?? null,
    mergeStateStatus: MERGE_STATES.find((m) => m === mergeState) ?? 'UNKNOWN',
    autoMerge: isObj(pr.autoMergeRequest),
    repo: { owner: str(obj(repo.owner), 'login'), name: str(repo, 'name'), methods, autoMergeAllowed: bool(repo, 'autoMergeAllowed') },
    truncated: {
      // threads join the timeline: theirs count there
      timeline: rest(pr, 'timelineItems', 'filteredCount') + rest(pr, 'reviewThreads'),
      commits: rest(pr, 'commits'),
      files: rest(pr, 'files'),
      checks: rollup ? rest(rollup, 'contexts') : 0,
    },
  }
}

/** The viewer's login from the same answer. */
export function viewerOf(raw: unknown): string {
  return str(obj(obj(obj(raw).data).viewer), 'login')
}
