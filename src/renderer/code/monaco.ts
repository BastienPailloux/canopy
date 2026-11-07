import * as monaco from 'monaco-editor'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

// Bundled by Vite as files of the app: the CSP allows 'self' only, so no CDN and no blob.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// A single file without its project: the language service would flag every import.
const quiet = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(quiet)
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(quiet)

// Definitions and references come from the worktree's language server (`CodeEditor`), not from this single-file service.
const modes = { ...monaco.typescript.typescriptDefaults.modeConfiguration, definitions: false, references: false }
monaco.typescript.typescriptDefaults.setModeConfiguration(modes)
monaco.typescript.javascriptDefaults.setModeConfiguration(modes)

export const THEME = 'canopy'
monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0D0E10',
    'editorGutter.background': '#0D0E10',
    'editor.lineHighlightBackground': '#15171B',
    'editorLineNumber.foreground': '#6B727C',
    'diffEditor.insertedLineBackground': '#12301a66',
    'diffEditor.removedLineBackground': '#3a14166b',
    'diffEditor.insertedTextBackground': '#2ea04333',
    'diffEditor.removedTextBackground': '#f8514933'
  }
})

export { monaco }
