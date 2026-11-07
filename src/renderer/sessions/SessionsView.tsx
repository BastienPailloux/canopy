import { useEffect, useMemo } from 'react'
import { TerminalControls } from '../terminal/TerminalControls'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { Composer } from './Composer'
import { Conversation } from './Conversation'
import { SessionTabs } from './SessionTabs'
import { ensureTab, syncWorktree, useSessions } from './sessionStore'
import './sessions.css'

export function SessionsView(props: { cwd: string; worktreeLabel: string }): React.JSX.Element {
  const { cwd, worktreeLabel } = props
  const allTabs = useSessions((s) => s.tabs)
  const activeId = useSessions((s) => s.active[cwd])
  const tabs = useMemo(() => Object.values(allTabs).filter((t) => t.cwd === cwd), [allTabs, cwd])
  const tab = activeId ? allTabs[activeId] : undefined

  useEffect(() => {
    void syncWorktree(cwd).finally(() => ensureTab(cwd))
  }, [cwd])

  return (
    <div className="sessions">
      <TerminalControls cwd={cwd} />
      <SessionTabs cwd={cwd} tabs={tabs} activeId={activeId} />
      {tab && (
        <>
          <Conversation key={tab.id} tab={tab} />
          <Composer key={`composer-${tab.id}`} tab={tab} worktreeLabel={worktreeLabel} />
        </>
      )}
      <TerminalPanel cwd={cwd} />
    </div>
  )
}
