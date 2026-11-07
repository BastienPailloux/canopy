import { memo, useMemo, useState } from 'react'
import { lineDiff, type DiffLine } from './lineDiff'
import type { TranscriptItem } from './transcript'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const MAX_DIFF_LINES = 400
const MAX_RESULT_CHARS = 20_000
const SIGNS: Record<DiffLine['kind'], string> = { add: '+', del: '−', same: ' ' }

const asText = (v: unknown): string => (typeof v === 'string' ? v : '')

const relativeTo = (cwd: string, path: string): string => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

/** What a tool acts on, in one line. Paths inside `cwd` are shown relative to it. */
export function toolTarget(name: string, input: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return relativeTo(cwd, asText(input.file_path))
    case 'Grep':
      return [`"${asText(input.pattern)}"`, relativeTo(cwd, asText(input.path))].filter(Boolean).join(' ')
    case 'Glob':
      return asText(input.pattern)
    case 'Bash':
      return asText(input.command)
    default:
      return Object.values(input).find((v): v is string => typeof v === 'string') ?? ''
  }
}

/** The change an Edit or Write makes, or null for any other tool. */
export function toolDiff(name: string, input: Record<string, unknown>): DiffLine[] | null {
  if (name === 'Edit') return lineDiff(asText(input.old_string), asText(input.new_string))
  if (name === 'Write') return lineDiff('', asText(input.content))
  return null
}

const countLines = (s: string): number => s.split('\n').filter((l) => l !== '').length
/** Read numbers each line of the file, including the empty one after a final newline, and may add text of its own. */
const countReadLines = (s: string): number =>
  s.replace(/\n\s*\d+[\t→]$/, '').split('\n').filter((l) => /^\s*\d+[\t→]/.test(l)).length

const plural = (n: number | string, word: string): string => `${n} ${word}${Number(n) > 1 ? 's' : ''}`

function outcome(item: ToolItem): string {
  if (item.isError) return 'Erreur'
  const result = item.result ?? ''
  if (item.name === 'Read') return plural(countReadLines(result), 'ligne')
  if (item.name === 'Grep' || item.name === 'Glob') {
    return plural(/^Found (\d+)/.exec(result)?.[1] ?? countLines(result), 'résultat')
  }
  return ''
}

export function DiffView(props: { lines: DiffLine[] }): React.JSX.Element {
  const shown = props.lines.slice(0, MAX_DIFF_LINES)
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

function Header(props: CardProps & { children?: React.ReactNode }): React.JSX.Element {
  const { item, cwd, onInterrupt, children } = props
  const target = toolTarget(item.name, item.input, cwd)
  return (
    <>
      {item.running && <span className="running-dot" aria-hidden="true" />}
      <span className="name">{item.name}</span>
      <span className="target" title={target}>{target}</span>
      <span className="end">
        {children}
        {item.running ? <Elapsed seconds={item.elapsed} /> : <span className={item.isError ? 'del' : 'outcome'}>{outcome(item)}</span>}
      </span>
      {item.running && onInterrupt && (
        <button type="button" className="interrupt" onClick={(e) => { e.stopPropagation(); onInterrupt() }}>Interrompre</button>
      )}
    </>
  )
}

function DiffCard(props: CardProps & { lines: DiffLine[] }): React.JSX.Element {
  const { lines, ...card } = props
  const { item } = card
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  return (
    <div className="tool-card with-diff" data-testid="tool-card" data-running={item.running}>
      <div className="tool-head">
        <Header {...card}>
          {added > 0 && <span className="add">+{added}</span>}
          {removed > 0 && <span className="del">−{removed}</span>}
        </Header>
      </div>
      <DiffView lines={lines} />
      {item.isError && item.result && <pre className="tool-output">{item.result}</pre>}
    </div>
  )
}

function PlainCard(props: CardProps): React.JSX.Element {
  const { item } = props
  const [open, setOpen] = useState(false)
  const output = item.result ?? ''
  return (
    <div className="tool-card" data-testid="tool-card" data-running={item.running}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Header {...props} />
      </button>
      {open && (
        <pre className="tool-output">
          {output === '' ? JSON.stringify(item.input, null, 2) : output.slice(0, MAX_RESULT_CHARS)}
        </pre>
      )}
    </div>
  )
}

export const ToolCard = memo(function ToolCard(props: CardProps): React.JSX.Element {
  const { item } = props
  const lines = useMemo(() => toolDiff(item.name, item.input), [item.name, item.input])
  return lines ? <DiffCard {...props} lines={lines} /> : <PlainCard {...props} />
})
