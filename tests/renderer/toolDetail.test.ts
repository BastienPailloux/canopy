import { describe, expect, it } from 'vitest'
import { approvalDetail, clipOutput, outcome, toolDiff, toolTarget } from '../../src/renderer/sessions/toolDetail'
import type { TranscriptItem } from '../../src/renderer/sessions/transcript'

type Tool = Extract<TranscriptItem, { kind: 'tool' }>
const tool = (o: Partial<Tool>): Tool => ({ kind: 'tool', id: 't', name: 'Read', input: {}, running: false, ...o })

describe('approvalDetail', () => {
  it('keeps a long multi-line command whole, and the other fields apart', () => {
    const command = `${'x'.repeat(3000)}\n  && rm -rf /\n`
    expect(approvalDetail('Bash', { command, timeout: 5 })).toEqual({ text: command, json: JSON.stringify({ timeout: 5 }, null, 2) })
  })

  it('shows the whole input of a generic or MCP tool, not its first string', () => {
    const input = { path: 'safe.txt', target: 'prod', nested: { force: true } }
    expect(approvalDetail('mcp__db__write', input)).toEqual({ json: JSON.stringify(input, null, 2) })
  })

  it('gives the full path of an edit, its diff apart, and options that change it', () => {
    const detail = approvalDetail('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b', replace_all: true })
    expect(detail).toEqual({ text: '/r/a.ts', json: JSON.stringify({ replace_all: true }, null, 2) })
  })

  it('has no json when nothing is left to show', () => {
    expect(approvalDetail('Bash', { command: 'ls' })).toEqual({ text: 'ls' })
  })
})

describe('toolDiff', () => {
  it('adds no empty line for the final newline of a Write', () => {
    expect(toolDiff('Write', { content: 'a\nb\n' })).toEqual([{ kind: 'add', text: 'a' }, { kind: 'add', text: 'b' }])
  })

  it('keeps a real empty last line', () => {
    expect(toolDiff('Write', { content: 'a\n\n' })).toHaveLength(2)
  })

  it('has no diff for other tools', () => {
    expect(toolDiff('Read', {})).toBeNull()
  })
})

describe('outcome', () => {
  it('does not read as a success without a result', () => {
    expect(outcome(tool({ name: 'Bash' }))).toBe('Sans résultat')
    expect(outcome(tool({ name: 'Edit' }))).toBe('Sans résultat')
  })

  it('is empty for a finished tool with nothing to count', () => {
    expect(outcome(tool({ name: 'Bash', result: 'ok', isError: false }))).toBe('')
  })

  it('reports errors, lines and results', () => {
    expect(outcome(tool({ result: 'boom', isError: true }))).toBe('Erreur')
    expect(outcome(tool({ name: 'Read', result: '1\thello\n2\t' }))).toBe('1 ligne')
    expect(outcome(tool({ name: 'Grep', result: 'Found 7 files\na\nb' }))).toBe('7 résultats')
  })
})

describe('clipOutput', () => {
  it('leaves short output alone', () => {
    expect(clipOutput('court')).toBe('court')
  })

  it('marks what it cut', () => {
    const out = clipOutput('x'.repeat(20_500))
    expect(out.startsWith('x'.repeat(20_000))).toBe(true)
    expect(out).toContain('500 caractères de plus')
    expect(out.length).toBeLessThan(20_100)
  })
})

describe('toolTarget', () => {
  it('shows paths inside the worktree relative to it', () => {
    expect(toolTarget('Read', { file_path: '/r/src/a.ts' }, '/r')).toBe('src/a.ts')
    expect(toolTarget('Read', { file_path: '/other/a.ts' }, '/r')).toBe('/other/a.ts')
  })
})
