import { useEffect } from 'react'
import { answerFor, ensureBranchBase, useBranchBases } from './branchBaseStore'

/** The base a stacked branch was created from (and a base found lost), shared by the Sessions and Code views. */
export function useBranchBase(cwd: string, branch: string): { base: string | null; lost: string | null } {
  const answers = useBranchBases((s) => s.answers)
  useEffect(() => { ensureBranchBase(cwd, branch) }, [cwd, branch])
  return answerFor(answers, cwd, branch)
}
