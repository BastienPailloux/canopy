import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { applyCompletion, filterCommands, filterFiles, findTrigger } from '../../src/renderer/sessions/completion'

describe('findTrigger', () => {
  it('finds a command only at the start of the message', () => {
    expect(findTrigger('/com', 4)).toEqual({ kind: 'command', query: 'com', start: 0 })
    expect(findTrigger('voir /com', 9)).toBeNull()
    expect(findTrigger('/compact maintenant', 19)).toBeNull()
  })

  it('finds a file reference after whitespace, up to the caret', () => {
    expect(findTrigger('lis @src/a', 10)).toEqual({ kind: 'file', query: 'src/a', start: 4 })
    expect(findTrigger('@a', 2)).toEqual({ kind: 'file', query: 'a', start: 0 })
    expect(findTrigger('lis\n@', 5)).toEqual({ kind: 'file', query: '', start: 4 })
  })

  it('ignores an @ inside a word and one the caret has left', () => {
    expect(findTrigger('moi@exemple.fr', 14)).toBeNull()
    expect(findTrigger('@a puis', 7)).toBeNull()
  })
})

describe('filterFiles', () => {
  const files = ['src/deep/alpha.ts', 'alpha/readme.md', 'src/beta.ts', 'docs/ALPHABET.md']

  it('matches anywhere, ignoring case, file names first', () => {
    expect(filterFiles(files, 'alpha')).toEqual(['src/deep/alpha.ts', 'docs/ALPHABET.md', 'alpha/readme.md'])
  })

  it('caps the list', () => {
    expect(filterFiles(files, '', 2)).toHaveLength(2)
  })
})

describe('filterCommands', () => {
  const cmd = (name: string): SlashCommand => ({ name, description: '', argumentHint: '' })

  it('puts name prefixes before other matches', () => {
    const list = [cmd('superpowers:compact'), cmd('compact'), cmd('context')]
    expect(filterCommands(list, 'com').map((c) => c.name)).toEqual(['compact', 'superpowers:compact'])
  })
})

describe('applyCompletion', () => {
  it('replaces the token, keeps what follows and leaves the caret after one space', () => {
    expect(applyCompletion('lis @sr et', 7, { kind: 'file', query: 'sr', start: 4 }, '@src/a.ts')).toEqual({
      text: 'lis @src/a.ts et', caret: 14
    })
    expect(applyCompletion('/co', 3, { kind: 'command', query: 'co', start: 0 }, '/compact')).toEqual({
      text: '/compact ', caret: 9
    })
  })
})
