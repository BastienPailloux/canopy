import { describe, expect, it } from 'vitest'
import { preview } from '../../src/shared/preview'

describe('preview', () => {
  it('drops the indentation', () => { expect(preview('   return x  ')).toBe('return x') })
  it('cuts long lines', () => { expect(preview('a'.repeat(300))).toBe(`${'a'.repeat(200)}…`) })
})
