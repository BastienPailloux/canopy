import { memo, useMemo, useState } from 'react'
import type { DiffLine } from './lineDiff'
import { useApp } from '../store'
import { clipOutput, outcome, plural, toolDiff, toolTarget, type ToolItem } from './toolDetail'

const MAX_DIFF_LINES = 400
const SIGNS: Record<DiffLine['kind'], string> = { add: '+', del: '−', same: ' ' }

/** A card shows a preview. Whoever must see everything, like an approval, passes `whole`. */
export function DiffView(props: { lines: DiffLine[]; whole?: boolean }): React.JSX.Element {
  const shown = props.whole ? props.lines : props.lines.slice(0, MAX_DIFF_LINES)
  const hidden = props.lines.length - shown.length
  return (
    <div className="diff" data-testid="tool-diff">
      {shown.map((l, i) => <div key={i} className={`line ${l.kind}`}>{`${SIGNS[l.kind]} ${l.text}`}</div>)}
      {hidden > 0 && <div className="line more">… {plural(hidden, 'ligne')} de plus</div>}
    </div>
  )
}

function Elapsed(props: { seconds?: number }): React.JSX.Element {
  const { seconds } = props
  return <span className="running-label">{seconds === undefined ? 'En cours' : `En cours · ${Math.round(seconds)} s`}</span>
}

interface CardProps { item: ToolItem; cwd: string; onInterrupt?: () => void }

function Summary(props: { item: ToolItem; cwd: string; children?: React.ReactNode }): React.JSX.Element {
  const { item, cwd, children } = props
  const target = toolTarget(item.name, item.input, cwd)
  const result = outcome(item)
  return (
    <>
      {item.running && <span className="running-dot" aria-hidden="true" />}
      <span className="name">{item.name}</span>
      <span className="target" title={target}>{target}</span>
      <span className="end">
        {children}
        {item.running
          ? <Elapsed seconds={item.elapsed} />
          : <span className={item.isError ? 'del' : item.result === undefined ? 'warn' : 'outcome'}>{result}</span>}
      </span>
    </>
  )
}

function InterruptButton(props: CardProps): React.JSX.Element | null {
  if (!props.item.running || !props.onInterrupt) return null
  return <button type="button" className="interrupt" onClick={props.onInterrupt}>Interrompre</button>
}

/** Opens the Code view on the file this Edit or Write changed, in Diff mode. */
function ViewDiffLink(props: { item: ToolItem; cwd: string }): React.JSX.Element | null {
  const { item, cwd } = props
  const path = toolTarget(item.name, item.input, cwd)
  // A file outside the worktree is not in the Code view.
  if (item.running || item.isError || path === '' || path.startsWith('/') || path.startsWith('..')) return null
  return (
    <button type="button" className="link-btn" onClick={() => useApp.getState().openInCode(cwd, path, 'diff')}>Voir le diff</button>
  )
}

function DiffCard(props: CardProps & { lines: DiffLine[] }): React.JSX.Element {
  const { lines, ...card } = props
  const { item, cwd } = card
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  return (
    <div className="tool-card with-diff" data-testid="tool-card" data-running={item.running}>
      <div className="tool-head">
        <div className="tool-summary">
          <Summary item={item} cwd={cwd}>
            {added > 0 && <span className="add">+{added}</span>}
            {removed > 0 && <span className="del">−{removed}</span>}
            <ViewDiffLink item={item} cwd={cwd} />
          </Summary>
        </div>
        <InterruptButton {...card} />
      </div>
      <DiffView lines={lines} />
      {item.isError && item.result && <pre className="tool-output">{clipOutput(item.result)}</pre>}
    </div>
  )
}

function PlainCard(props: CardProps): React.JSX.Element {
  const { item, cwd } = props
  const [open, setOpen] = useState(false)
  const output = item.result ?? ''
  return (
    <div className="tool-card" data-testid="tool-card" data-running={item.running}>
      <div className="tool-head">
        <button type="button" className="tool-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Summary item={item} cwd={cwd} />
        </button>
        <InterruptButton {...props} />
      </div>
      {open && <pre className="tool-output">{output === '' ? JSON.stringify(item.input, null, 2) : clipOutput(output)}</pre>}
    </div>
  )
}

export const ToolCard = memo(function ToolCard(props: CardProps): React.JSX.Element {
  const { item } = props
  const lines = useMemo(() => toolDiff(item.name, item.input), [item.name, item.input])
  return lines ? <DiffCard {...props} lines={lines} /> : <PlainCard {...props} />
})
