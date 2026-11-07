import { useEffect, useMemo, useState } from 'react'
import type { Activity, WorktreeStatus } from '../../shared/types'
import { useApp } from '../store'
import { poll, POLL_HEALTHY_MS } from './polling'
import { createStatusReads, rowStatuses, statusRows, type StatusRow } from './statusReads'

export const STATUS_LABEL: Record<WorktreeStatus, string> = {
  waiting: 'Attend ta réponse',
  working: 'Claude travaille',
  pr_open: 'PR ouverte',
  idle: 'Inactif'
}

/**
 * Status of every worktree of the workspace. Sessions changing state refresh their activity at once and never touch
 * gh. The open PRs are read per repo on the slow poll, cached by the main process, and a window focus asks sooner for
 * the active repo.
 */
export function useStatuses(): Record<string, WorktreeStatus> {
  const key = useApp((s) => JSON.stringify(statusRows(s.workspace, s.worktrees, s.repo)))
  const rows = useMemo(() => JSON.parse(key) as StatusRow[], [key])
  const [activities, setActivities] = useState<Record<string, Activity>>({})
  const [prs, setPrs] = useState<Record<string, string[] | null>>({})

  useEffect(() => {
    let live = true
    const reads = createStatusReads(rows, {
      activity: (path) => window.canopy.sessionActivity(path),
      openPrs: (repo, soon) => window.canopy.openPrs(repo, soon),
      activeRepo: () => useApp.getState().repo,
      onActivity: (path, activity) => { if (live) setActivities((prev) => (prev[path] === activity ? prev : { ...prev, [path]: activity })) },
      onPrs: (repo, branches) => { if (live) setPrs((prev) => ({ ...prev, [repo]: branches })) }
    })
    const readBoth = (onFocus: boolean): void => {
      void reads.activities()
      void reads.prs(onFocus)
    }
    readBoth(false)
    const stopPolling = poll(() => readBoth(false), POLL_HEALTHY_MS)
    const onFocus = (): void => readBoth(true)
    window.addEventListener('focus', onFocus)
    const off = window.canopy.on('session:state', () => void reads.activities())
    return () => {
      live = false
      stopPolling()
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [rows])

  return useMemo(() => rowStatuses(rows, activities, prs), [rows, activities, prs])
}
