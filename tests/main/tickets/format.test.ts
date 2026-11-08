import { describe, expect, it } from 'vitest'
import { parseTicket, serializeTicket, unknownFields } from '../../../src/main/tickets/format'
import type { Ticket } from '../../../src/shared/tickets'

const full: Ticket = {
  id: 'DPP-12',
  title: 'Export JSON-LD du passeport textile',
  description: "Exposer le passeport.\n\n## Notes\nVoir le contexte.",
  status: 'todo',
  priority: 'high',
  labels: ['DPP', 'Textile'],
  subtasks: [
    { title: 'Définir le contexte JSON-LD', done: true },
    { title: 'Sérialiseur passeport → JSON-LD', done: false },
  ],
  branch: 'feat/export-jsonld-textile',
  worktree: '/Users/x/dpp-api/.worktrees/feat-export-jsonld-textile',
  base: 'main',
  created: '2026-11-08T10:12:00Z',
  updated: '2026-11-08T10:40:00Z',
  archived: false,
}

const minimal = (body: string, extra = '') =>
  `---\nid: DPP-1\ntitle: T\nstatus: todo\npriority: none\nlabels: []\ncreated: 2026-11-08T10:12:00Z\nupdated: 2026-11-08T10:12:00Z\n${extra}---\n${body}`

describe('ticket format', () => {
  it('round-trips a full ticket', () => {
    expect(parseTicket(serializeTicket(full), full.id)).toEqual(full)
  })

  it('emits keys in a stable order', () => {
    const keys = serializeTicket(full).split('---')[1].split('\n').filter((l) => /^\w+:/.test(l)).map((l) => l.split(':')[0])
    expect(keys).toEqual(['id', 'title', 'status', 'priority', 'labels', 'created', 'updated', 'branch', 'worktree', 'base'])
  })

  it('subtasks section is optional', () => {
    const t = parseTicket(minimal('Juste une description\n\navec deux paragraphes'), 'DPP-1')
    expect(t.subtasks).toEqual([])
    expect(t.description).toBe('Juste une description\n\navec deux paragraphes')
  })

  it('only the last "## Sous-tâches" heading is reserved', () => {
    const t = parseTicket(minimal('Intro\n\n## Sous-tâches\nnotes\n\n## Sous-tâches\n- [x] a\n- [ ] b\n'), 'DPP-1')
    expect(t.description).toBe('Intro\n\n## Sous-tâches\nnotes')
    expect(t.subtasks).toEqual([{ title: 'a', done: true }, { title: 'b', done: false }])
  })

  it('throws on invalid front matter', () => {
    expect(() => parseTicket('---\ntitle: [unclosed\n---\nx', 'DPP-1')).toThrow()
    expect(() => parseTicket(minimal('x').replace('status: todo', 'status: wip'), 'DPP-1')).toThrow()
  })

  it('keeps unknown front-matter keys', () => {
    const x = minimal('x', 'linear_id: ABC-1\n')
    expect(serializeTicket(parseTicket(x, 'DPP-1'), unknownFields(x))).toContain('linear_id: ABC-1')
  })

  it('id comes from the file name when missing from front matter', () => {
    const x = minimal('x').replace('id: DPP-1\n', '')
    expect(parseTicket(x, 'DPP-7').id).toBe('DPP-7')
  })

  it('serializes archived only when true', () => {
    expect(serializeTicket(full)).not.toContain('archived')
    const out = serializeTicket({ ...full, archived: true })
    expect(out).toContain('archived: true')
    expect(parseTicket(out, full.id).archived).toBe(true)
  })

  it('round-trips a title and label ending in ---', () => {
    const t = { ...full, title: 'Fix ---', labels: ['a ---'] }
    expect(parseTicket(serializeTicket(t), t.id)).toEqual(t)
  })

  it('throws on empty front matter and on no front matter', () => {
    expect(() => parseTicket('---\n---\n', 'DPP-1')).toThrow(/title/)
    expect(() => parseTicket('juste du texte', 'DPP-1')).toThrow()
  })

  it('reads numeric title and labels as strings', () => {
    const t = parseTicket(minimal('x').replace('title: T', 'title: 2026').replace('labels: []', 'labels: [2025]'), 'DPP-1')
    expect(t.title).toBe('2026')
    expect(t.labels).toEqual(['2025'])
  })
})
