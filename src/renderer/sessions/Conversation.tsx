import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { pinnedLabel, pinnedUserIndex } from './pinnedPrompt'
import { QuestionCard, questionsOf } from './QuestionCard'
import { interrupt, type SessionTab, useSessions } from './sessionStore'
import { ToolCard } from './ToolCard'
import type { TranscriptItem } from './transcript'

const ESTIMATED_ROW_PX = 72
const OVERSCAN_ROWS = 8
/** Within this distance of the end, the list keeps following what arrives. */
const FOLLOW_PX = 48

const Item = memo(function Item(props: { item: TranscriptItem; cwd: string; onInterrupt?: () => void }): React.JSX.Element {
  const { item, cwd, onInterrupt } = props
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user" data-testid="user-message">
          {item.images.map((img, i) => <img key={i} alt="Image jointe" src={`data:${img.mediaType};base64,${img.base64}`} />)}
          {item.documents && (
            <div className="doc-chips">
              {item.documents.map((d, i) => (
                <span key={i} className="doc-chip" title={d.name}>
                  <span className="doc-chip-kind">PDF</span>
                  <span className="doc-chip-name">{d.name}</span>
                </span>
              ))}
            </div>
          )}
          {item.text}
        </div>
      )
    case 'assistant':
      return <div className="msg-assistant" data-testid="assistant-message"><Markdown text={item.text} /></div>
    case 'tool':
      return <ToolCard item={item} cwd={cwd} onInterrupt={onInterrupt} />
    case 'notice':
      return <p className="msg-notice" data-testid="notice">{item.text}</p>
  }
})

function PendingRequests(props: { localId?: string }): React.JSX.Element | null {
  const { localId } = props
  const permissions = useSessions((s) => s.permissions)
  const mine = permissions.filter((p) => p.localId === localId)
  if (!localId || mine.length === 0) return null
  return (
    <div className="pending">
      {mine.map((p) => {
        const questions = p.toolName === 'AskUserQuestion' ? questionsOf(p.input) : null
        return questions
          ? <QuestionCard key={p.requestId} request={p} questions={questions} />
          : <PermissionCard key={p.requestId} request={p} />
      })}
    </div>
  )
}

export function Conversation(props: { tab: SessionTab }): React.JSX.Element {
  const { tab } = props
  const { items } = tab.transcript
  const scroller = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [pinned, setPinned] = useState<number>()
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: OVERSCAN_ROWS,
    // The list's top padding: without it, scrolling to a row stops short and shows the one before.
    scrollMargin: list.current?.offsetTop ?? 0
  })
  const total = rows.getTotalSize()
  const onInterrupt = useCallback(() => interrupt(tab.id), [tab.id])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  })

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX
    // The rendered range may still be stale here, measurements are not.
    const row = rows.getVirtualItemForOffset(el.scrollTop)
    setPinned(row ? pinnedUserIndex(items, [row], el.scrollTop) : undefined)
  }

  const goToPinned = (): void => {
    if (pinned === undefined) return
    following.current = false
    rows.scrollToIndex(pinned, { align: 'start' })
  }

  const pinnedItem = pinned === undefined ? undefined : items[pinned]

  return (
    <>
      <div className="conversation" ref={scroller} onScroll={onScroll} data-testid="conversation">
        {pinnedItem?.kind === 'user' && (
          <div className="pinned-prompt-anchor">
            <button type="button" className="pinned-prompt" data-testid="pinned-prompt"
              title="Revenir à ce message" onClick={goToPinned}>
              {pinnedLabel(pinnedItem)}
            </button>
          </div>
        )}
        <div className="conversation-rows" ref={list} style={{ height: total }}>
          {rows.getVirtualItems().map((row) => {
            const item = items[row.index]
            const tight = item.kind === 'tool' && items[row.index + 1]?.kind === 'tool'
            return (
              <div key={row.key} ref={rows.measureElement} data-index={row.index} data-tight={tight}
                className="conversation-row" style={{ transform: `translateY(${row.start - rows.options.scrollMargin}px)` }}>
                <Item item={item} cwd={tab.cwd} onInterrupt={tab.localId ? onInterrupt : undefined} />
              </div>
            )
          })}
        </div>
      </div>
      <PendingRequests localId={tab.localId} />
    </>
  )
}
