export type Format = 'bold' | 'list' | 'code'

/**
 * The description after a toolbar button, and the selection to restore: bold and code wrap the selection in `**` or
 * `` ` ``, list starts each line it touches with `- `.
 */
export function applyFormat(value: string, start: number, end: number, format: Format): { value: string; start: number; end: number } {
  if (format === 'list') {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const lines = value.slice(lineStart, end).split('\n')
    const listed = lines.map((l) => `- ${l}`).join('\n')
    return { value: value.slice(0, lineStart) + listed + value.slice(end), start: start + 2, end: end + 2 * lines.length }
  }
  const mark = format === 'bold' ? '**' : '`'
  return {
    value: value.slice(0, start) + mark + value.slice(start, end) + mark + value.slice(end),
    start: start + mark.length,
    end: end + mark.length
  }
}
