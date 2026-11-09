import { expect, test } from 'vitest'
import { claudeThreadLabel, hunkRows, isViewerClaudeReply, lineLabel, withoutSignature } from '../../src/renderer/pr/conversationModel'
import { isClaudeReply, type PrComment } from '../../src/shared/pr'

test('the Claude button follows the session started for the thread', () => {
  expect(claudeThreadLabel(undefined)).toEqual({ label: 'Faire corriger par Claude', busy: false })
  // A draft never sent (trust refused, start failed): the button comes back.
  expect(claudeThreadLabel('draft')).toEqual({ label: 'Faire corriger par Claude', busy: false })
  expect(claudeThreadLabel('running')).toEqual({ label: 'Claude traite le retour', busy: true })
  expect(claudeThreadLabel('waiting')).toEqual({ label: 'Claude traite le retour', busy: true })
  expect(claudeThreadLabel('idle')).toEqual({ label: 'Claude a traité le retour', busy: false })
  expect(claudeThreadLabel('stopped')).toEqual({ label: 'Claude a traité le retour', busy: false })
  // A failed start can be tried again.
  expect(claudeThreadLabel('error')).toEqual({ label: 'Faire corriger par Claude', busy: false })
})

test('lines of a thread, as GitHub labels them', () => {
  expect(lineLabel({ line: 20, startLine: 19 })).toBe('L19–20')
  expect(lineLabel({ line: 20, startLine: null })).toBe('L20')
  expect(lineLabel({ line: 20, startLine: 20 })).toBe('L20')
  expect(lineLabel({ line: null, startLine: null })).toBe('')
})

test('the signature line goes, the reply stays', () => {
  expect(withoutSignature('Good catch.\n\n— Claude via Canopy')).toBe('Good catch.')
  expect(withoutSignature('Good catch.\n— Claude via Canopy\n')).toBe('Good catch.')
  expect(withoutSignature('No signature here')).toBe('No signature here')
  expect(withoutSignature('inline — Claude via Canopy')).toBe('inline — Claude via Canopy')
})

test('hunk rows number the new side, the old side for a deletion, and keep the last ones', () => {
  const hunk = '@@ -15,3 +15,3 @@ router\n   const a = 1\n-  old()\n+  neu()\n+  more()'
  expect(hunkRows(hunk, 10)).toEqual([
    { n: 15, kind: 'same', text: '  const a = 1' },
    { n: 16, kind: 'del', text: '  old()' },
    { n: 16, kind: 'add', text: '  neu()' },
    { n: 17, kind: 'add', text: '  more()' }
  ])
  expect(hunkRows(hunk, 2).map((r) => r.text)).toEqual(['  neu()', '  more()'])
  expect(hunkRows('@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file', 5)).toEqual([
    { n: 1, kind: 'del', text: 'a' },
    { n: 1, kind: 'add', text: 'b' }
  ])
  expect(hunkRows('no header\n+x', 5)).toEqual([{ n: null, kind: 'same', text: 'no header' }, { n: null, kind: 'add', text: 'x' }])
})

test('the signature counts only as the body\'s own last line', () => {
  expect(isClaudeReply('— Claude via Canopy')).toBe(true)
  expect(isClaudeReply('Fixed.\n\n— Claude via Canopy\n')).toBe(true)
  expect(isClaudeReply('Fixed. — Claude via Canopy')).toBe(false)
  expect(isClaudeReply('Fixed.\nnot — Claude via Canopy')).toBe(false)
})

test('only the viewer\'s own signed comments show as Claude\'s', () => {
  const c = (login: string, body: string): PrComment => ({ id: 'x', databaseId: 1, author: { login, bot: false }, body, createdAt: '' })
  expect(isViewerClaudeReply(c('basti', 'Fixed.\n\n— Claude via Canopy'), 'basti')).toBe(true)
  // Anyone can type the signature: someone else's comment stays theirs.
  expect(isViewerClaudeReply(c('mallory', 'Fixed.\n\n— Claude via Canopy'), 'basti')).toBe(false)
  expect(isViewerClaudeReply(c('basti', 'Fixed. — Claude via Canopy'), 'basti')).toBe(false)
})
