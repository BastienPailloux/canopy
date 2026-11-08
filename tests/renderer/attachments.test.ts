import { describe, expect, it } from 'vitest'
import { sortFiles } from '../../src/renderer/sessions/attachments'
import { MAX_DOCUMENT_BYTES } from '../../src/shared/sessionOptions'

const file = (name: string, type: string, size = 10) => ({ name, type, size })

describe('sortFiles', () => {
  it('puts images and PDFs apart, in order', () => {
    const a = file('a.png', 'image/png')
    const b = file('spec.pdf', 'application/pdf')
    const c = file('b.webp', 'image/webp')
    expect(sortFiles([a, b, c])).toEqual({ images: [a, c], documents: [b], error: null })
  })

  it('refuses other types and says what is accepted', () => {
    const r = sortFiles([file('a.svg', 'image/svg+xml'), file('notes.txt', 'text/plain')])
    expect(r.images).toEqual([])
    expect(r.documents).toEqual([])
    expect(r.error).toBe('Seuls les PDF et les images PNG, JPEG, GIF et WebP sont acceptés.')
  })

  it('refuses a PDF over the limit, by name', () => {
    const big = file('gros.pdf', 'application/pdf', MAX_DOCUMENT_BYTES + 1)
    const ok = file('petit.pdf', 'application/pdf')
    expect(sortFiles([big, ok])).toEqual({ images: [], documents: [ok], error: '« gros.pdf » dépasse 32 Mo, la limite de Claude.' })
  })
})
