import { create } from 'zustand'

export interface BranchBaseAnswer { base: string | null; lost: string | null }

const NONE: BranchBaseAnswer = { base: null, lost: null }

export const useBranchBases = create<{ answers: Record<string, BranchBaseAnswer> }>(() => ({ answers: {} }))

const asked = new Set<string>()

export const branchBaseKey = (cwd: string, branch: string): string => `${cwd}\0${branch}`

/**
 * Asks main for the base of `branch` once per key: main reports a lost base only once, so the answer is kept for every view.
 * A failed read is forgotten so that the next consumer asks again.
 */
export function ensureBranchBase(cwd: string, branch: string): void {
  const key = branchBaseKey(cwd, branch)
  if (asked.has(key)) return
  asked.add(key)
  window.canopy.branchBase(cwd).then(
    (r) => useBranchBases.setState((s) => ({ answers: { ...s.answers, [key]: { base: r && 'base' in r ? r.base : null, lost: r && 'lost' in r ? r.lost : null } } })),
    () => { asked.delete(key) }
  )
}

export const answerFor = (answers: Record<string, BranchBaseAnswer>, cwd: string, branch: string): BranchBaseAnswer =>
  answers[branchBaseKey(cwd, branch)] ?? NONE

/** For tests. */
export function resetBranchBases(): void {
  asked.clear()
  useBranchBases.setState({ answers: {} })
}
