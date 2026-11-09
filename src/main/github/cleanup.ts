export interface NextBranchInput {
  /** Branches checked out in the worktree, most recent last. */
  history: string[]
  current: string
  locals: Set<string>
  base: string | null
  heldElsewhere: Set<string>
  prState: (branch: string) => 'open' | 'merged' | 'closed' | null
}

/** The branch a worktree goes back to once its PR is merged: the latest one still being worked on. */
export function nextBranch(o: NextBranchInput): string | null {
  for (let i = o.history.length - 1; i >= 0; i--) {
    const b = o.history[i]
    if (b === o.current || !o.locals.has(b) || b === o.base || o.heldElsewhere.has(b)) continue
    const state = o.prState(b)
    if (state === null || state === 'open') return b
  }
  return null
}
