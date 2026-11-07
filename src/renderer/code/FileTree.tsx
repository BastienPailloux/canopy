import { useMemo, useState } from 'react'
import type { ChangedFile } from '../../shared/types'

interface Dir { name: string; path: string; dirs: Dir[]; files: string[] }

const MARKS: Record<ChangedFile['kind'], { text: string; className: string }> = {
  A: { text: 'A', className: 'add' },
  M: { text: 'M', className: 'mod' },
  D: { text: 'D', className: 'del' },
  R: { text: 'R', className: 'mod' }
}

const MAX_MATCHES = 200

function buildTree(paths: string[]): Dir {
  const root: Dir = { name: '', path: '', dirs: [], files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = dir.dirs.find((d) => d.path === path)
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [] }
        dir.dirs.push(next)
      }
      dir = next
    }
    dir.files.push(p)
  }
  return root
}

/** True when the characters of `query` appear in order in `path`, which is how ⌘P-style filters read. */
export function matches(path: string, query: string): boolean {
  const p = path.toLowerCase()
  let at = 0
  for (const c of query.toLowerCase()) {
    at = p.indexOf(c, at)
    if (at < 0) return false
    at++
  }
  return true
}

const chevron = (open: boolean): React.JSX.Element => (
  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    style={{ transform: open ? undefined : 'rotate(-90deg)' }}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

function FileRow(props: { path: string; depth: number; label: string; kind?: ChangedFile['kind']; selected: boolean; onSelect: (p: string) => void }): React.JSX.Element {
  const { path, kind } = props
  return (
    <button type="button" className="tree-file" aria-current={props.selected} data-testid="tree-file" data-path={path}
      style={{ paddingLeft: 8 + props.depth * 14 }} title={path} onClick={() => props.onSelect(path)}>
      <span className="label">{props.label}</span>
      {kind && <span className={`mark ${MARKS[kind].className}`}>{MARKS[kind].text}</span>}
    </button>
  )
}

function DirNode(props: {
  dir: Dir; depth: number; open: Set<string>; toggle: (p: string) => void
  kinds: Map<string, ChangedFile['kind']>; selected: string | null; onSelect: (p: string) => void
}): React.JSX.Element {
  const { dir, depth, open } = props
  const sorted = useMemo(() => [...dir.dirs].sort((a, b) => a.name.localeCompare(b.name)), [dir.dirs])
  const files = useMemo(() => [...dir.files].sort((a, b) => a.localeCompare(b)), [dir.files])
  return (
    <>
      {sorted.map((d) => {
        const isOpen = open.has(d.path)
        return (
          <div key={d.path}>
            <button type="button" className="tree-dir" aria-expanded={isOpen} style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => props.toggle(d.path)}>
              {chevron(isOpen)}{d.name}
            </button>
            {isOpen && <DirNode {...props} dir={d} depth={depth + 1} />}
          </div>
        )
      })}
      {files.map((f) => (
        <FileRow key={f} path={f} depth={depth} label={f.slice(f.lastIndexOf('/') + 1)} kind={props.kinds.get(f)}
          selected={f === props.selected} onSelect={props.onSelect} />
      ))}
    </>
  )
}

/** Folders of the selected file stay open; the rest is the user's choice. */
function ancestors(path: string | null): string[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export function FileTree(props: {
  paths: string[]
  changed: ChangedFile[]
  selected: string | null
  query: string
  onSelect: (path: string) => void
}): React.JSX.Element {
  const { paths, selected, query } = props
  const [userOpen, setUserOpen] = useState<Set<string>>(new Set())
  const kinds = useMemo(() => new Map(props.changed.map((f) => [f.path, f.kind])), [props.changed])
  const root = useMemo(() => buildTree(paths), [paths])
  const open = useMemo(() => new Set([...userOpen, ...ancestors(selected)]), [userOpen, selected])
  // Folders holding changes start open, so that the changes show without hunting for them.
  const [seeded, setSeeded] = useState(false)
  if (!seeded && props.changed.length > 0) {
    setSeeded(true)
    setUserOpen(new Set(props.changed.flatMap((f) => ancestors(f.path))))
  }
  const toggle = (p: string): void => setUserOpen((prev) => {
    const next = new Set(prev)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    return next
  })

  if (query.trim() !== '') {
    const found = paths.filter((p) => matches(p, query.trim()))
    return (
      <div className="tree" data-testid="file-tree">
        {found.slice(0, MAX_MATCHES).map((p) => (
          <FileRow key={p} path={p} depth={0} label={p} kind={kinds.get(p)} selected={p === selected} onSelect={props.onSelect} />
        ))}
        {found.length === 0 && <p className="tree-empty">Aucun fichier.</p>}
        {found.length > MAX_MATCHES && <p className="tree-empty">… {found.length - MAX_MATCHES} de plus, précise le filtre.</p>}
      </div>
    )
  }
  return (
    <div className="tree" data-testid="file-tree">
      {paths.length === 0 && <p className="tree-empty">Aucun fichier.</p>}
      <DirNode dir={root} depth={0} open={open} toggle={toggle} kinds={kinds} selected={selected} onSelect={props.onSelect} />
    </div>
  )
}
