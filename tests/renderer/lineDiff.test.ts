import { describe, expect, it } from 'vitest'
import { lineDiff } from '../../src/renderer/sessions/lineDiff'

describe('lineDiff', () => {
  it('keeps common lines and marks the changed ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' }
    ])
  })

  it('treats an empty side as nothing, so a new file is only additions', () => {
    expect(lineDiff('', 'a\nb')).toEqual([{ kind: 'add', text: 'a' }, { kind: 'add', text: 'b' }])
    expect(lineDiff('a', '')).toEqual([{ kind: 'del', text: 'a' }])
  })

  it('finds a line moved between unchanged neighbours', () => {
    const kinds = lineDiff('x\na\nb\ny', 'x\nb\na\ny').map((l) => l.kind)
    expect(kinds.filter((k) => k === 'same')).toHaveLength(3)
  })

  it('falls back to replacing everything between the common ends when the change is huge', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    const diff = lineDiff(`debut\n${before}\nfin`, `debut\n${after}\nfin`)
    expect(diff).toHaveLength(6002)
    expect(diff[0]).toEqual({ kind: 'same', text: 'debut' })
    expect(diff[1].kind).toBe('del')
    expect(diff.at(-1)).toEqual({ kind: 'same', text: 'fin' })
  })
})
