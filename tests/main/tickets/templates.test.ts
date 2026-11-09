import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATES, assertTemplateSlug, parseTemplate, parseTemplateFields, serializeTemplate } from '../../../src/main/tickets/templates'
import { MAX_DESCRIPTION, MAX_LABEL, MAX_LABELS, MAX_SUBTASKS, MAX_TEMPLATE_NAME, MAX_TITLE, TEMPLATE_SLUG_RE, sortTemplates, templateSlug, type TemplateFields, type TicketTemplate } from '../../../src/shared/tickets'

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

  it('ignores an order that is not an integer, which saving would refuse', () => {
    expect('order' in parseTemplate('---\nname: X\norder: 1.5\n---\nbody\n', 'x')).toBe(false)
    expect(parseTemplate('---\nname: X\norder: 3\n---\nbody\n', 'x').order).toBe(3)
  })

  it('refuses a template without name', () => {
    expect(() => parseTemplate('---\n---\nbody', 'x')).toThrow(/name/)
  })

  it('refuses an unknown priority and a missing front matter', () => {
    expect(() => parseTemplate('---\nname: X\npriority: huge\n---\n', 'x')).toThrow('Priorité inconnue : huge')
    expect(() => parseTemplate('no front matter', 'x')).toThrow('Front matter manquant')
  })

  it('refuses values beyond the limits the templates screen and ticket creation enforce', () => {
    const f = (over: Partial<TemplateFields>): string => serializeTemplate({ name: 'X', description: '', priority: 'none', labels: [], subtasks: [], ...over })
    expect(() => parseTemplate(f({ name: 'n'.repeat(MAX_TEMPLATE_NAME + 1) }), 'x')).toThrow('Champ « name » trop long')
    expect(() => parseTemplate(f({ name: ' ' }), 'x')).toThrow('Champ « name » invalide')
    expect(() => parseTemplate(f({ description: 'd'.repeat(MAX_DESCRIPTION + 1) }), 'x')).toThrow('Description trop longue')
    expect(() => parseTemplate(f({ labels: Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`) }), 'x')).toThrow('Champ « labels » invalide')
    expect(() => parseTemplate(f({ labels: ['l'.repeat(MAX_LABEL + 1)] }), 'x')).toThrow('Champ « labels » invalide')
    expect(() => parseTemplate('---\nname: X\nlabels: [""]\n---\n', 'x')).toThrow('Champ « labels » invalide')
    expect(() => parseTemplate(f({ subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, () => ({ title: 't', done: false })) }), 'x')).toThrow('Trop de sous-tâches')
    expect(() => parseTemplate(f({ subtasks: [{ title: 't'.repeat(MAX_TITLE + 1), done: false }] }), 'x')).toThrow('Sous-tâche trop longue')
    const max = f({ name: 'n'.repeat(MAX_TEMPLATE_NAME), labels: ['l'.repeat(MAX_LABEL)], subtasks: [{ title: 't'.repeat(MAX_TITLE), done: false }] })
    expect(parseTemplate(max, 'x').name).toHaveLength(MAX_TEMPLATE_NAME)
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

describe('template IPC validation', () => {
  it('refuses a slug that is not a-z0-9-', () => {
    for (const s of ['../x', 'Bug', '', 'a'.repeat(51), 3]) expect(() => assertTemplateSlug(s)).toThrow('Modèle invalide')
    expect(() => assertTemplateSlug('bug-2')).not.toThrow()
  })

  it('refuses invalid template fields', () => {
    const ok = { name: 'Bug', description: '', priority: 'none', labels: [], subtasks: [] }
    for (const bad of [
      { ...ok, name: '' }, { ...ok, name: 'x'.repeat(51) }, { ...ok, slug: 'bug' },
      { ...ok, priority: 'x' }, { ...ok, order: 1.5 }, { ...ok, labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }
    ]) expect(() => parseTemplateFields(bad)).toThrow(/invalide/)
  })

  it('returns a clean copy of valid fields', () => {
    const raw = { name: 'Bug', order: 2, description: 'd', priority: 'high', labels: ['a'], subtasks: [{ title: 't', done: true, extra: 1 }] }
    const out = parseTemplateFields(raw)
    expect(out).toEqual({ ...raw, subtasks: [{ title: 't', done: true }] })
    expect(out.subtasks).not.toBe(raw.subtasks)
  })
})
