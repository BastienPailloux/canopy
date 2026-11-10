import { describe, expect, it } from 'vitest'
import { parseFields, parseNewTicket } from '../../../src/main/tickets/ticketIpc'

describe('ticket IPC parent', () => {
  it('refuses a malformed parent', () => {
    expect(() => parseFields({ parent: 'x y' })).toThrow('Parent invalide')
    expect(() => parseFields({ parent: 12 })).toThrow('Parent invalide')
  })

  it('accepts a ticket id', () => {
    expect(parseFields({ parent: 'CAN-3' })).toEqual({ parent: 'CAN-3' })
  })

  it('maps null to a present key with value undefined (remove the parent)', () => {
    const f = parseFields({ parent: null })
    expect('parent' in f).toBe(true)
    expect(f.parent).toBeUndefined()
  })

  it('creates a ticket with a null parent without a parent', () => {
    const f = parseNewTicket({ title: 't', parent: null })
    expect(f.parent).toBeUndefined()
  })
})
