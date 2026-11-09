import { describe, expect, it } from 'vitest'
import { pinnedLabel, pinnedUserIndex } from '../../src/renderer/sessions/pinnedPrompt'
import type { TranscriptItem } from '../../src/renderer/sessions/transcript'

const user = (text: string): TranscriptItem => ({ kind: 'user', text, images: [] })
const reply = (text: string): TranscriptItem => ({ kind: 'assistant', text, streaming: false })

// Rows of 100px each, one per item.
const rowsOf = (items: TranscriptItem[]): { index: number; start: number; end: number }[] =>
  items.map((_, index) => ({ index, start: index * 100, end: (index + 1) * 100 }))

describe('pinnedUserIndex', () => {
  const items = [user('a'), reply('1'), reply('2'), user('b'), reply('3'), reply('4')]
  const rows = rowsOf(items)

  it('pins nothing while the top of the conversation shows', () => {
    expect(pinnedUserIndex(items, rows, 0)).toBeUndefined()
  })

  it('pins the message whose reply fills the top once it scrolled out of view', () => {
    expect(pinnedUserIndex(items, rows, 150)).toBe(0)
    expect(pinnedUserIndex(items, rows, 450)).toBe(3)
  })

  it('pins a message cut at the top, not one fully in view', () => {
    expect(pinnedUserIndex(items, rows, 320)).toBe(3)
    expect(pinnedUserIndex(items, rows, 300)).toBeUndefined()
  })

  it('pins nothing before the first message or without rows', () => {
    expect(pinnedUserIndex([reply('0'), user('a'), reply('1')], rowsOf([reply('0'), user('a'), reply('1')]), 50)).toBeUndefined()
    expect(pinnedUserIndex(items, [], 150)).toBeUndefined()
  })

  it('reads rows in any order, as only some are rendered', () => {
    expect(pinnedUserIndex(items, [rows[5], rows[4]], 450)).toBe(3)
  })
})

describe('pinnedLabel', () => {
  it('shows the text sent', () => {
    expect(pinnedLabel({ kind: 'user', text: 'corrige le bug', images: [] })).toBe('corrige le bug')
  })

  it('names the attachments of a message sent without text', () => {
    const image = { mediaType: 'image/png', base64: '' }
    expect(pinnedLabel({ kind: 'user', text: '  ', images: [image] })).toBe('Image jointe')
    expect(pinnedLabel({ kind: 'user', text: '', images: [image, image], documents: [{ name: 'spec.pdf' }, { name: 'plan.pdf' }] }))
      .toBe('2 images jointes · spec.pdf, plan.pdf')
  })
})
