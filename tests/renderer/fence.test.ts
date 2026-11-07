import { expect, it } from 'vitest'
import { askMessage } from '../../src/renderer/code/askMessage'
import { fenceFor } from '../../src/renderer/fence'
import { formatLogs } from '../../src/renderer/terminal/logs'

const many = '` '.repeat(300_000)

it('a fence is at least three backticks and longer than any run', () => {
  expect(fenceFor('abc')).toBe('```')
  expect(fenceFor('x ```` y')).toBe('`````')
})

it('a selection of 300 000 separate backticks still builds a message', () => {
  expect(askMessage('a.ts', { text: many, startLine: 1, endLine: 1 }, 'Q')).toContain('```\n')
})

it('logs of 300 000 separate backticks still format', () => {
  expect(formatLogs('dev', many)).toContain('dernières lignes')
})
