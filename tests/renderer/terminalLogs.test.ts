import { expect, it } from 'vitest'
import { formatLogs } from '../../src/renderer/terminal/logs'

it('sends the last 200 lines in a code block', () => {
  const raw = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n'
  const text = formatLogs('web', raw)
  const body = text.split('```\n')[1].split('\n```')[0].split('\n')
  expect(body).toHaveLength(200)
  expect(body[0]).toBe('line 100')
  expect(body.at(-1)).toBe('line 299')
  expect(text).toContain('web')
})

it('drops colors, cursor moves and progress overwrites', () => {
  const raw = '\u001b[32mok\u001b[0m\r\nprogress 10%\rprogress 100%\r\n\u001b]0;title\u0007done\r\n'
  expect(formatLogs('web', raw)).toContain('```\nok\nprogress 100%\ndone\n```')
})

it('uses a fence longer than any backtick run of the logs', () => {
  expect(formatLogs('x', '```\nhi\n```\n')).toContain('````\n```\nhi\n```\n````')
})

it('says so when there is no output', () => {
  expect(formatLogs('x', '\r\n')).toContain('aucune sortie')
})
