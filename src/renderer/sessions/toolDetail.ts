import { lineDiff, type DiffLine } from './lineDiff'
import type { TranscriptItem } from './transcript'

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const MAX_OUTPUT_CHARS = 20_000

const asText = (v: unknown): string => (typeof v === 'string' ? v : '')
const relativeTo = (cwd: string, path: string): string => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

export const plural = (n: number | string, word: string): string => `${n} ${word}${Number(n) > 1 ? 's' : ''}`

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
  // A final newline ends the last line, it does not start another.
  if (name === 'Write') return lineDiff('', asText(input.content).replace(/\n$/, ''))
  return null
}

export interface ApprovalDetail {
  /** The command or path, verbatim. */
  text?: string
  /** All the other fields. */
  json?: string
}

/** Everything a request asks for, apart from what its diff already shows. */
export function approvalDetail(name: string, input: Record<string, unknown>): ApprovalDetail {
  const json = (rest: Record<string, unknown>): ApprovalDetail =>
    (Object.keys(rest).length > 0 ? { json: JSON.stringify(rest, null, 2) } : {})
  if (name === 'Bash' && typeof input.command === 'string') {
    const { command, ...rest } = input
    return { text: command, ...json(rest) }
  }
  if (name === 'Edit' || name === 'Write') {
    const { file_path: path, old_string: _old, new_string: _new, content: _content, ...rest } = input
    return { text: asText(path), ...json(rest) }
  }
  return json(input)
}

const countLines = (s: string): number => s.split('\n').filter((l) => l !== '').length
/** Read numbers each line of the file, including the empty one after a final newline, and may add text of its own. */
const countReadLines = (s: string): number =>
  s.replace(/\n\s*\d+[\t→]$/, '').split('\n').filter((l) => /^\s*\d+[\t→]/.test(l)).length

/** How a finished tool ended, in a few words. */
export function outcome(item: ToolItem): string {
  if (item.isError) return 'Erreur'
  // The turn ended before the tool answered: nothing says it did its work.
  if (item.result === undefined) return 'Sans résultat'
  if (item.name === 'Read') return plural(countReadLines(item.result), 'ligne')
  if (item.name === 'Grep' || item.name === 'Glob') {
    return plural(/^Found (\d+)/.exec(item.result)?.[1] ?? countLines(item.result), 'résultat')
  }
  return ''
}

export function clipOutput(output: string): string {
  const hidden = output.length - MAX_OUTPUT_CHARS
  return hidden > 0 ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… ${plural(hidden, 'caractère')} de plus` : output
}
