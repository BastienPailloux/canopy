import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATES, parseTemplate, serializeTemplate } from '../../../src/main/tickets/templates'
import { TEMPLATE_SLUG_RE, sortTemplates, templateSlug, type TemplateFields, type TicketTemplate } from '../../../src/shared/tickets'

describe('template format', () => {
  it('round-trips a template', () => {
    const f: TemplateFields = {
      name: 'Bug',
      order: 2,
      description: '### Contexte\nOù.',
      priority: 'high',
      labels: ['bug'],
      subtasks: [{ title: 'Écrire un test qui reproduit le bug', done: false }],
    }
    expect(parseTemplate(serializeTemplate(f), 'bug')).toEqual({ ...f, slug: 'bug' })
  })

  it('defaults priority to none and labels to empty', () => {
    const t = parseTemplate('---\nname: X\n---\nbody\n', 'x')
    expect(t.priority).toBe('none')
    expect(t.labels).toEqual([])
    expect(t.subtasks).toEqual([])
    expect('order' in t).toBe(false)
  })

  it('refuses a template without name', () => {
    expect(() => parseTemplate('---\n---\nbody', 'x')).toThrow(/name/)
  })

  it('refuses an unknown priority and a missing front matter', () => {
    expect(() => parseTemplate('---\nname: X\npriority: huge\n---\n', 'x')).toThrow('Priorité inconnue : huge')
    expect(() => parseTemplate('no front matter', 'x')).toThrow('Front matter manquant')
  })
})

describe('templateSlug', () => {
  it('computes a valid slug', () => {
    expect(templateSlug('Bug')).toBe('bug')
    expect(templateSlug('Fonctionnalité')).toBe('fonctionnalite')
    expect(templateSlug('  !! ')).toBe('modele')
    expect(templateSlug('a'.repeat(80))).toHaveLength(50)
    for (const n of ['Bug', 'Fonctionnalité', '  !! ', 'a'.repeat(80), 'x'.repeat(49) + ' y']) expect(templateSlug(n)).toMatch(TEMPLATE_SLUG_RE)
  })
})

describe('sortTemplates', () => {
  it('puts ordered templates first, then alphabetical', () => {
    const mk = (name: string, order?: number) => ({ slug: name, name, order, description: '', priority: 'none', labels: [], subtasks: [] }) as TicketTemplate
    expect(sortTemplates([mk('B'), mk('a', 2), mk('C', 1)]).map((t) => t.name)).toEqual(['C', 'a', 'B'])
    expect(sortTemplates([mk('Ezra'), mk('Été'), mk('Zoé')]).map((t) => t.name)).toEqual(['Été', 'Ezra', 'Zoé'])
  })
})

describe('built-in templates', () => {
  it('ships the four templates in order', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.slug)).toEqual(['contexte', 'fonctionnalite', 'bug', 'refacto'])
    for (const b of BUILTIN_TEMPLATES) {
      expect(b.slug).toMatch(TEMPLATE_SLUG_RE)
      expect(parseTemplate(serializeTemplate(b.fields), b.slug)).toEqual({ ...b.fields, slug: b.slug })
    }
  })

  it('has the expected content', () => {
    const by = Object.fromEntries(BUILTIN_TEMPLATES.map((t) => [t.slug, t.fields]))
    expect(by.contexte.description).toContain('### Contexte')
    expect(by.contexte.description).toContain("### Critères d'acceptation")
    expect(by.bug.labels).toEqual(['bug'])
    expect(by.bug.subtasks).toHaveLength(1)
  })
})
