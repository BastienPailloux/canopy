import { useEffect, useRef } from 'react'
import { monaco, THEME } from './monaco'

export interface Selection { text: string; startLine: number; endLine: number }
/** Lets the screen read what is selected, when "Demander à Claude" opens. */
export interface EditorHandle { selection: () => Selection | null }

type Editor = monaco.editor.IStandaloneCodeEditor

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: THEME,
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12.5,
  lineHeight: 22,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderWhitespace: 'none',
  padding: { top: 8, bottom: 8 }
}

function selectionOf(editor: Editor): Selection | null {
  const range = editor.getSelection()
  const model = editor.getModel()
  if (!range || !model || range.isEmpty()) return null
  // A selection ending at a line's very start does not include that line.
  const endLine = range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber
  return { text: model.getValueInRange(range), startLine: range.startLineNumber, endLine }
}

let modelCount = 0

/** A model for `path`'s language, under a URI of its own: the caller disposes it. */
function newModel(side: 'work' | 'base', path: string, value: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme: side === 'work' ? 'canopy' : 'canopy-base', path: `/${path}`, query: String(modelCount++) })
  return monaco.editor.createModel(value, undefined, uri)
}

export function CodeEditor(props: {
  path: string
  /** The buffer: the editor follows it, and reports typing through `onChange`. */
  value: string
  readOnly: boolean
  /** 1-based lines added since the base. */
  addedLines: number[]
  onChange: (text: string) => void
  onSave: () => void
  handle: React.RefObject<EditorHandle | null>
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    if (!host.current) return
    const editor = monaco.editor.create(host.current, { ...OPTIONS, model: null, readOnly: true })
    editorRef.current = editor
    decorations.current = editor.createDecorationsCollection()
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave())
    editor.onDidChangeModelContent(() => latest.current.onChange(editor.getValue()))
    latest.current.handle.current = { selection: () => selectionOf(editor) }
    return () => {
      const model = editor.getModel()
      editor.dispose()
      model?.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const old = editor.getModel()
    editor.setModel(newModel('work', props.path, props.value))
    old?.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== props.value) model.setValue(props.value)
  }, [props.value, props.path])

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: props.readOnly }) }, [props.readOnly])

  useEffect(() => {
    decorations.current?.set(props.addedLines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'code-line-added', linesDecorationsClassName: 'code-line-added-bar' }
    })))
  }, [props.addedLines, props.path])

  return <div ref={host} className="monaco-host" data-testid="code-editor" />
}

export function DiffPane(props: {
  path: string
  original: string
  modified: string
  handle: React.RefObject<EditorHandle | null>
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    if (!host.current) return
    const diff = monaco.editor.createDiffEditor(host.current, {
      ...OPTIONS,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      renderOverviewRuler: false
    })
    diffRef.current = diff
    props.handle.current = { selection: () => selectionOf(diff.getModifiedEditor()) }
    return () => {
      const model = diff.getModel()
      diff.dispose()
      model?.original.dispose()
      model?.modified.dispose()
      diffRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const diff = diffRef.current
    if (!diff) return
    const old = diff.getModel()
    diff.setModel({ original: newModel('base', props.path, props.original), modified: newModel('work', props.path, props.modified) })
    old?.original.dispose()
    old?.modified.dispose()
  }, [props.path, props.original, props.modified])

  return <div ref={host} className="monaco-host" data-testid="diff-editor" />
}
