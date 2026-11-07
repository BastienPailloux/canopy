import { describe, expect, test } from 'vitest'
import { nextVersion, notesFor, renderMarkdown } from '../../scripts/release/versioning.ts'

const c = (s: string) => ({ subject: s, body: '' })

describe('versioning', () => {
  test('no tag yet gives 1.0.0 whatever the commits', () => {
    expect(nextVersion(null, [{ subject: 'chore: x', body: '' }])).toBe('1.0.0')
  })
  test('fix gives patch, feat minor, breaking major', () => {
    expect(nextVersion('v1.2.3', [c('fix(cli): a')])).toBe('1.2.4')
    expect(nextVersion('v1.2.3', [c('fix: a'), c('feat(shell): b')])).toBe('1.3.0')
    expect(nextVersion('v1.2.3', [c('feat!: a')])).toBe('2.0.0')
    expect(nextVersion('v1.2.3', [{ subject: 'refactor: a', body: 'BREAKING CHANGE: api' }])).toBe('2.0.0')
    expect(nextVersion('v1.2.3', [c('perf: a')])).toBe('1.2.4')
  })
  test('no release', () => {
    expect(nextVersion('v1.2.3', [c('chore: a'), c('docs: b'), c('Merge branch develop')])).toBeNull()
  })
  test('notes drop type and scope, split features and fixes', () => {
    const n = notesFor('1.3.0', '2026-11-08', [c('feat(shell): show the account'), c('fix: parse names'), c('chore: x')], false)
    expect(n).toEqual({ version: '1.3.0', date: '2026-11-08', features: ['Show the account'], fixes: ['Parse names'] })
  })
  test('first release notes', () => {
    expect(notesFor('1.0.0', '2026-11-08', [c('feat: a')], true)).toEqual({ version: '1.0.0', date: '2026-11-08', features: ['Première version'], fixes: [] })
  })
  test('markdown has French headings and omits empty sections', () => {
    expect(renderMarkdown({ version: '1.3.0', date: 'd', features: ['A'], fixes: [] })).toBe('## Nouveautés\n\n- A\n')
  })
})
