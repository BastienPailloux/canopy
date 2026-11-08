import { useEffect, useState } from 'react'

/**
 * The base a stacked branch was created from, read again when the worktree or its branch changes.
 * A lost base is reported by main once only: it is kept here from that first answer.
 */
export function useBranchBase(cwd: string, branch: string): { base: string | null; lost: string | null } {
  const [state, setState] = useState<{ key: string; base: string | null; lost: string | null }>({ key: '', base: null, lost: null })
  const key = `${cwd}\0${branch}`
  useEffect(() => {
    let current = true
    window.canopy.branchBase(cwd).then(
      (r) => { if (current) setState({ key, base: r && 'base' in r ? r.base : null, lost: r && 'lost' in r ? r.lost : null }) },
      () => { if (current) setState({ key, base: null, lost: null }) }
    )
    return () => { current = false }
  }, [cwd, key])
  return state.key === key ? { base: state.base, lost: state.lost } : { base: null, lost: null }
}
