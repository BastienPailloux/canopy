import { useEffect, useState } from 'react'
import type { WorktreeStatus } from '../../shared/types'
import { useApp } from '../store'

const REFRESH_MS = 10_000

export const STATUS_LABEL: Record<WorktreeStatus, string> = {
  waiting: 'Attend ta réponse',
  working: 'Claude travaille',
  pr_open: 'PR ouverte',
  idle: 'Inactif'
}

/**
 * Status of every worktree of the repo. Sessions changing state refresh it at once; the PR part is cached by the
 * main process (60 s per worktree), and a window focus asks for it sooner. A failing read keeps the last status.
 */
export function useStatuses(repo: string): Record<string, WorktreeStatus> {
  const paths = useApp((s) => s.worktrees.map((w) => w.path).join('\0'))
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus>>({})

  useEffect(() => {
    let live = true
    const list = paths === '' ? [] : paths.split('\0')
    const read = (onFocus: boolean): void => {
      for (const path of list) {
        window.canopy.worktreeStatus(path, onFocus).then(
          (status) => { if (live) setStatuses((prev) => (prev[path] === status ? prev : { ...prev, [path]: status })) },
          () => undefined
        )
      }
    }
    read(false)
    const timer = setInterval(() => read(false), REFRESH_MS)
    const onFocus = (): void => read(true)
    window.addEventListener('focus', onFocus)
    const off = window.canopy.on('session:state', () => read(false))
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [repo, paths])

  return statuses
}
