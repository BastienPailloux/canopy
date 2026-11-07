import { describe, expect, it } from 'vitest'
import { askMessage } from '../../src/renderer/code/askMessage'

describe('askMessage', () => {
  it('names the file when nothing is selected', () => {
    expect(askMessage('src/a.ts', null, ' Pourquoi ? ')).toBe('À propos de `src/a.ts` :\n\nPourquoi ?')
  })

  it('quotes the selection with its lines', () => {
    expect(askMessage('src/a.ts', { text: 'x = 1', startLine: 4, endLine: 4 }, 'Quoi ?'))
      .toBe('À propos de `src/a.ts` (ligne 4) :\n\n```\nx = 1\n```\n\nQuoi ?')
    expect(askMessage('a', { text: 'a\nb', startLine: 2, endLine: 3 }, 'Q')).toContain('(lignes 2–3)')
  })

  it('uses a fence longer than any backtick run of the selection', () => {
    const msg = askMessage('a.md', { text: '```js\ncode\n```', startLine: 1, endLine: 3 }, 'Q')
    expect(msg).toContain('````\n```js\ncode\n```\n````')
  })
})
