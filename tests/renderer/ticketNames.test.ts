import { describe, expect, it } from 'vitest'
import { branchSlug, defaultPrefix, launchPrompt } from '../../src/shared/tickets'
import type { Ticket } from '../../src/shared/tickets'

const ticket: Ticket = {
  id: 'DPP-12',
  title: 'Export JSON-LD du passeport textile',
  description: 'Exposer le passeport.',
  status: 'todo',
  priority: 'high',
  labels: [],
  subtasks: [{ title: 'Fait', done: true }, { title: 'Reste', done: false }],
  created: '2026-11-08T10:12:00Z',
  updated: '2026-11-08T10:12:00Z',
  archived: false,
}

describe('ticket names', () => {
  it('slugs a title', () => {
    expect(branchSlug('Export JSON-LD du passeport textile')).toBe('export-json-ld-du-passeport')
    expect(branchSlug('Évite l’accès « spécial » !!')).toBe('evite-l-acces-special')
    expect(branchSlug('   ')).toBe('ticket')
  })

  it('derives a default prefix', () => {
    expect(defaultPrefix('canopy')).toBe('CAN')
    expect(defaultPrefix('dpp-api')).toBe('DPP')
    expect(defaultPrefix('42')).toBe('TKT')
  })

  it('builds the launch prompt', () => {
    const p = launchPrompt(ticket)
    expect(p).toContain('DPP-12 : Export JSON-LD du passeport textile')
    expect(p).toContain('Exposer le passeport.')
    expect(p).toContain('- [ ] Reste')
    expect(p).not.toContain('Fait')
    expect(launchPrompt({ ...ticket, subtasks: [{ title: 'Fait', done: true }] })).not.toContain('Sous-tâches')
  })
})
