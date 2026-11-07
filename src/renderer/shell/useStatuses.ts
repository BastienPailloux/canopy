import { useEffect, useState } from 'react'
import type { WorktreeStatus } from '../../shared/types'
import { useApp } from '../store'
import { eachLimit, poll, POLL_HEALTHY_MS } from './polling'
import { entryPaths } from './workspaceList'

export const STATUS_LABEL: Record<WorktreeStatus, string> = {
  waiting: 'Attend ta réponse',
  working: 'Claude travaille',
  pr_open: 'PR ouverte',
  idle: 'Inactif'
}

/** A status can cost a gh call. */
const STATUS_CONCURRENCY = 8

/**
 * Status of every worktree of the workspace. Sessions changing state refresh it at once; the PR part is cached by the
 * main process (60 s per worktree), and a window focus asks for it sooner. A failing read keeps the last status.
 */
export function useStatuses(): Record<string, WorktreeStatus> {
  const paths = useApp((s) => entryPaths(s.workspace, s.worktrees).join('\0'))
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus>>({})

  useEffect(() => {
    let live = true
    const list = paths === '' ? [] : paths.split('\0')
    const read = (onFocus: boolean): void => {
      void eachLimit(list, STATUS_CONCURRENCY, (path) => window.canopy.worktreeStatus(path, onFocus).then(
        (status) => { if (live) setStatuses((prev) => (prev[path] === status ? prev : { ...prev, [path]: status })) },
        () => undefined
      ))
    }
    read(false)
    const stopPolling = poll(() => read(false), POLL_HEALTHY_MS)
    const onFocus = (): void => read(true)
    window.addEventListener('focus', onFocus)
    const off = window.canopy.on('session:state', () => read(false))
    return () => {
      live = false
      stopPolling()
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [paths])

  return statuses
}
