/** A pull request as the PR tab shows it, read from GitHub through `gh` (src/main/github). */

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type MergeMethod = 'squash' | 'merge' | 'rebase'
export type CheckOutcome = 'success' | 'failure' | 'pending' | 'neutral'
export interface PrUser { login: string; bot: boolean }
export interface PrSummary { number: number; state: PrState; title: string; url: string }
export interface PrComment { id: string; databaseId: number; author: PrUser; body: string; createdAt: string }
export interface PrThread { id: string; path: string; line: number | null; startLine: number | null; diffHunk: string; resolved: boolean; outdated: boolean; comments: PrComment[] }
export type PrReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
export type PrTimelineItem =
  | { kind: 'comment'; at: string; comment: PrComment }
  | { kind: 'review'; at: string; author: PrUser; state: PrReviewState; body: string }
  | { kind: 'push'; at: string; author: PrUser; count: number }
  | { kind: 'thread'; at: string; thread: PrThread }
  /** Derived by the parser from the last commit's check rollup: one item, at that commit's date. */
  | { kind: 'ci'; at: string; sha: string; outcome: CheckOutcome }
export interface PrCheck { name: string; detail: string; outcome: CheckOutcome; durationMs: number | null; url: string | null
  /** GitHub Actions only: null for a check another app reports (Greptile…), which cannot be rerun. */
  run: { runId: number; jobId: number } | null }
export interface PrCommit { oid: string; message: string; author: string; at: string; outcome: CheckOutcome | null }
export interface PrFile { path: string; change: 'A' | 'M' | 'D' | 'R'; additions: number; deletions: number; viewed: boolean }
export interface PrReviewer { login: string; kind: 'user' | 'team' | 'bot'; status: 'approved' | 'changes' | 'commented' | 'pending' }
export interface PrDetail {
  number: number; url: string; title: string; body: string; state: PrState; author: PrUser; createdAt: string
  base: string; head: string; headOid: string; additions: number; deletions: number
  viewerIsAuthor: boolean; viewerLogin: string
  timeline: PrTimelineItem[]; commits: PrCommit[]; checks: PrCheck[]; files: PrFile[]
  reviewers: PrReviewer[]; assignees: string[]; labels: string[]
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeStateStatus: 'CLEAN' | 'BLOCKED' | 'BEHIND' | 'DIRTY' | 'UNSTABLE' | 'HAS_HOOKS' | 'DRAFT' | 'UNKNOWN'
  autoMerge: boolean
  repo: { owner: string; name: string; methods: MergeMethod[]; autoMergeAllowed: boolean }
  /** Connections cut at 100 items: how many more GitHub has, per list. */
  truncated: { timeline: number; commits: number; files: number; checks: number }
}
export type PrAction =
  | { type: 'comment'; body: string }
  | { type: 'reply'; commentId: number; body: string }          // REST databaseId of the thread's first comment
  | { type: 'resolve'; threadId: string; resolved: boolean }
  | { type: 'review'; event: 'APPROVE' | 'REQUEST_CHANGES'; body: string }
  | { type: 'editBody'; body: string }
  | { type: 'draft'; draft: boolean }
  | { type: 'close' } | { type: 'reopen' }
  | { type: 'reviewers'; add: string[]; remove: string[] }    // logins, `org/team`, or `copilot`
  | { type: 'assignees'; add: string[]; remove: string[] }
  | { type: 'labels'; add: string[]; remove: string[] }
  | { type: 'viewed'; path: string; viewed: boolean }
  | { type: 'rerun'; runId: number; jobId: number | null }    // null: the run's failed jobs
  | { type: 'updateBranch' }
  /** `headOid`: the head shown; GitHub refuses the merge if a commit was pushed since. Rebase ignores subject and body. */
  | { type: 'merge'; method: MergeMethod; subject: string; body: string; headOid: string }
  | { type: 'autoMerge'; enable: boolean; method: MergeMethod; subject: string; body: string; headOid: string }
  | { type: 'revert' }
  | { type: 'deleteRemoteBranch'; branch: string }
/** `url`: the revert PR. */
export type PrActResult = { ok: true } | { ok: true; url: string }
export interface PrOptions { labels: string[]; assignable: string[]; suggested: { login: string; kind: 'user' | 'team' | 'bot'; hint: string }[] }

/** Last line of every reply Claude writes from Canopy: how the tab tells them from the user's own. */
export const CLAUDE_SIGNATURE = '— Claude via Canopy'
/** The signature must be the body's own last line: `… — Claude via Canopy` within a sentence is not one. */
export const isClaudeReply = (body: string): boolean => {
  const text = body.trimEnd()
  return text === CLAUDE_SIGNATURE || text.endsWith(`\n${CLAUDE_SIGNATURE}`)
}
/** GitHub refuses a body or comment longer than this. */
export const MAX_PR_BODY = 65_536

/** What the cleanup after a merge needs of the PR: `headOid` is its head commit, the only tip a local branch may be deleted at. */
export interface CleanupRequest { number: number; branch: string; headOid: string }
/** An auto-merge enabled from the tab; `cleanup`: its box was checked. */
export type AutoMergeEntry = CleanupRequest & { cleanup: boolean }
/** `check`: main asked GitHub whether the PR is merged; nothing runs when it is not. */
export type CleanupStep = { step: 'check' | 'remote' | 'switch' | 'local' | 'update'; ok: boolean; message?: string }
export type CleanupOutcome =
  /** Uncommitted files, or changes Canopy set aside for the branch (`setAside`): nothing done locally. */
  | { kind: 'dirty'; files: number; setAside?: true }
  | { kind: 'switched'; branch: string; steps: CleanupStep[] }
  /** No branch to go back to: the renderer offers to remove the worktree. */
  | { kind: 'proposeRemoval'; steps: CleanupStep[] }
  /** A step failed: the later ones were skipped. */
  | { kind: 'failed'; steps: CleanupStep[] }
