import { describe, expect, it } from 'vitest'
import { applyFormat } from '../../src/renderer/tickets/descriptionTools'

describe('applyFormat', () => {
  it('wraps the selection in ** for bold, ` for code, keeping it selected', () => {
    expect(applyFormat('un mot ici', 3, 6, 'bold')).toEqual({ value: 'un **mot** ici', start: 5, end: 8 })
    expect(applyFormat('un mot ici', 3, 6, 'code')).toEqual({ value: 'un `mot` ici', start: 4, end: 7 })
  })
  it('without selection, puts the caret between the marks', () => {
    expect(applyFormat('ab', 1, 1, 'bold')).toEqual({ value: 'a****b', start: 3, end: 3 })
  })
  it('starts each selected line with "- " for a list', () => {
    expect(applyFormat('x\nun\ndeux\ny', 3, 7, 'list')).toEqual({ value: 'x\n- un\n- deux\ny', start: 5, end: 11 })
    expect(applyFormat('', 0, 0, 'list')).toEqual({ value: '- ', start: 2, end: 2 })
  })
})
