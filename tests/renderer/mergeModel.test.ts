import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PrDetail, PrThread } from '../../src/shared/pr'
import { tabCounts } from '../../src/renderer/pr/mergeModel'

const fixture = (): PrDetail => (JSON.parse(readFileSync('tests/fixtures/gh/pr.json', 'utf8')) as { detail: PrDetail }).detail
const thread = (id: string, resolved: boolean): PrThread =>
  ({ id, path: 'a.ts', line: 1, startLine: null, diffHunk: '', resolved, outdated: false, comments: [] })

describe('tabCounts', () => {
  it('tabCounts counts unresolved threads and failed checks', () => {
    const pr: PrDetail = {
      ...fixture(),
      timeline: [
        { kind: 'thread', at: '1', thread: thread('a', false) },
        { kind: 'thread', at: '2', thread: thread('b', true) },
        { kind: 'thread', at: '3', thread: thread('c', false) }
      ],
      checks: [
        { name: 'lint', detail: '', outcome: 'success', durationMs: 1, url: null, run: null },
        { name: 'e2e', detail: '', outcome: 'failure', durationMs: 1, url: null, run: null },
        { name: 'build', detail: '', outcome: 'pending', durationMs: null, url: null, run: null }
      ]
    }
    const c = tabCounts(pr)
    expect(c.openThreads).toBe(2)
    expect(c.commits).toBe(pr.commits.length)
    expect(c.checks).toEqual({ ok: 1, total: 3 })
    expect(c.files).toBe(pr.files.length)
    expect(c.alert).toEqual({ conv: true, checks: true })
  })

  it('raises no alert once every thread is resolved and no check failed', () => {
    const pr: PrDetail = {
      ...fixture(),
      timeline: [{ kind: 'thread', at: '1', thread: thread('a', true) }],
      checks: [{ name: 'build', detail: '', outcome: 'pending', durationMs: null, url: null, run: null }]
    }
    expect(tabCounts(pr).alert).toEqual({ conv: false, checks: false })
  })
})
