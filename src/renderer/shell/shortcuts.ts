import { useApp } from '../store'

/** Keeps the main process told of what is active, so that it greys the menu entries that would do nothing. */
export function connectShortcutContext(): () => void {
  let sent = ''
  const report = (): void => {
    const { repo, worktree } = useApp.getState()
    const ctx = { repo: repo !== null, worktree: worktree !== null }
    const key = `${ctx.repo}:${ctx.worktree}`
    if (key === sent) return
    sent = key
    void window.canopy.reportShortcutContext(ctx).catch(() => { sent = '' })
  }
  report()
  return useApp.subscribe(report)
}
