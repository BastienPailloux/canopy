import { useCallback, useEffect, useRef, useState } from 'react'
import type { BaseRef, ChangedFile } from '../../shared/types'

export interface CodeData {
  base: BaseRef | null
  files: ChangedFile[]
  tree: string[]
  branches: string[]
  /** Why the branch list could not be read, if so. */
  branchesError: string | null
  /** Live refresh stopped (the watcher failed): the screen polls instead. */
  watchError: string | null
  /** The last refresh failed: `files` and `tree` are the last good ones. */
  error: string | null
  loading: boolean
  /** Changes with every completed refresh, for whatever shows file content. */
  tick: number
}

const POLL_MS = 10_000
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Changed files, file list and branches of a worktree, compared against `pickedBase` (default branch when unset).
 * Refreshed on its own when the main process reports a change, and on window focus. A failing refresh
 * keeps the last good data and reports the error, so the view never goes blank.
 */
export function useCodeData(cwd: string, pickedBase: string | undefined): CodeData & { refresh: () => void } {
  const [data, setData] = useState<CodeData>({ base: null, files: [], tree: [], branches: [], branchesError: null, watchError: null, error: null, loading: true, tick: 0 })
  const live = useRef({ cwd, pickedBase })
  live.current = { cwd, pickedBase }
  const inFlight = useRef(false)
  const again = useRef(false)

  const refresh = useCallback((): void => {
    if (inFlight.current) {
      again.current = true
      return
    }
    inFlight.current = true
    const asked = live.current
    const stale = (): boolean => live.current.cwd !== asked.cwd || live.current.pickedBase !== asked.pickedBase
    void (async () => {
      const [changes, tree, branches] = await Promise.allSettled([
        window.canopy.codeChanges(asked.cwd, asked.pickedBase),
        window.canopy.listTree(asked.cwd),
        window.canopy.codeBranches(asked.cwd)
      ])
      inFlight.current = false
      if (!stale()) {
        const failure = [changes, tree].find((r): r is PromiseRejectedResult => r.status === 'rejected')
        setData((prev) => ({
          watchError: prev.watchError,
          base: changes.status === 'fulfilled' ? changes.value.base : prev.base,
          files: changes.status === 'fulfilled' ? changes.value.files : prev.files,
          tree: tree.status === 'fulfilled' ? tree.value : prev.tree,
          branches: branches.status === 'fulfilled' ? branches.value : prev.branches,
          branchesError: branches.status === 'rejected' ? errorText(branches.reason) : null,
          error: failure ? errorText(failure.reason) : null,
          loading: false,
          tick: prev.tick + 1
        }))
      }
      if (again.current || stale()) {
        again.current = false
        refresh()
      }
    })()
  }, [])

  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    // Another worktree: what is shown is not about the new one. Another base keeps it until the comparison arrives.
    if (shownFor.current !== cwd) {
      shownFor.current = cwd
      setData({ base: null, files: [], tree: [], branches: [], branchesError: null, watchError: null, error: null, loading: true, tick: 0 })
    }
    refresh()
  }, [cwd, pickedBase, refresh])

  const watchFailed = data.watchError !== null
  useEffect(() => {
    if (!watchFailed) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [watchFailed, refresh])

  useEffect(() => {
    const off = window.canopy.on('code:changed', (p) => {
      if ((p as { cwd?: string } | null)?.cwd === live.current.cwd) refresh()
    })
    const offError = window.canopy.on('code:watchError', (p) => {
      const e = p as { cwd?: string; message?: string } | null
      if (e?.cwd === live.current.cwd) setData((prev) => ({ ...prev, watchError: e.message ?? 'erreur inconnue' }))
    })
    window.addEventListener('focus', refresh)
    return () => {
      off()
      offError()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  return { ...data, refresh }
}
