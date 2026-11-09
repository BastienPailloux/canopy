import { Document, isSeq } from 'yaml'
import { MAX_DESCRIPTION, MAX_LABEL, MAX_LABELS, MAX_SUBTASKS, MAX_TEMPLATE_NAME, MAX_TITLE, PRIORITIES, TEMPLATE_SLUG_RE, type TemplateFields, type TicketPriority, type TicketTemplate } from '../../shared/tickets'
import { splitBody, splitFrontMatter } from './format'

const SUBTASKS_HEADING = '## Sous-tâches'

/**
 * Throws when the front matter is missing or invalid, or a value is beyond the limits `parseTemplateFields` and
 * ticket creation enforce: a hand-edited template that passed here would make every save and ticket from it fail.
 */
export function parseTemplate(text: string, slug: string): TicketTemplate {
  const { data, body } = splitFrontMatter(text)
  if (typeof data.name !== 'string' || data.name.trim() === '') throw new Error('Champ « name » invalide')
  if (data.name.length > MAX_TEMPLATE_NAME) throw new Error('Champ « name » trop long')
  const priority = data.priority ?? 'none'
  if (!PRIORITIES.includes(priority as TicketPriority)) throw new Error(`Priorité inconnue : ${String(priority)}`)
  const labels = data.labels ?? []
  if (!Array.isArray(labels) || labels.length > MAX_LABELS
    || labels.some((l) => (typeof l !== 'string' && typeof l !== 'number') || String(l) === '' || String(l).length > MAX_LABEL)) throw new Error('Champ « labels » invalide')
  const { description, subtasks } = splitBody(body)
  if (description.length > MAX_DESCRIPTION) throw new Error('Description trop longue')
  if (subtasks.length > MAX_SUBTASKS) throw new Error('Trop de sous-tâches')
  if (subtasks.some((s) => s.title.length > MAX_TITLE)) throw new Error('Sous-tâche trop longue')
  const t: TicketTemplate = { slug, name: data.name, description, priority: priority as TicketPriority, labels: labels.map(String), subtasks }
  // Integers only, as `parseTemplateFields` wants: any other order would make every save of the template fail.
  if (Number.isInteger(data.order)) t.order = data.order as number
  return t
}

export function serializeTemplate(t: TemplateFields): string {
  const front: Record<string, unknown> = { name: t.name }
  if (t.priority !== 'none') front.priority = t.priority
  if (t.labels.length) front.labels = t.labels
  if (t.order !== undefined) front.order = t.order
  const doc = new Document(front)
  const labels = doc.get('labels', true)
  if (isSeq(labels)) labels.flow = true
  let out = `---\n${doc.toString({ flowCollectionPadding: false })}---\n${t.description}\n`
  if (t.subtasks.length) {
    out += `\n${SUBTASKS_HEADING}\n${t.subtasks.map((s) => `- [${s.done ? 'x' : ' '}] ${s.title}`).join('\n')}\n`
  }
  return out
}

/** Written to `.tickets/templates/` the first time templates are needed; the user owns them afterwards. */
export const BUILTIN_TEMPLATES: { slug: string; fields: TemplateFields }[] = [
  {
    slug: 'contexte',
    fields: {
      name: 'Contexte',
      order: 1,
      priority: 'none',
      labels: [],
      subtasks: [],
      description: [
        '### Contexte',
        'Pourquoi ce ticket : quel problème ou quel besoin.',
        '',
        '### Où ça se passe',
        'Écrans, fichiers, modules concernés.',
        '',
        '### Ce qui existe déjà',
        'Code, tickets, décisions liées.',
        '',
        '### Objectif',
        'Ce qu’on veut obtenir.',
        '',
        '### Critères d\'acceptation',
        '- ',
        '',
        '### Hors périmètre',
      ].join('\n'),
    },
  },
  {
    slug: 'fonctionnalite',
    fields: {
      name: 'Fonctionnalité',
      order: 2,
      priority: 'none',
      labels: ['feat'],
      subtasks: [],
      description: [
        '### Contexte',
        'Pourquoi cette fonctionnalité, ce qui existe déjà.',
        '',
        '### Besoin utilisateur',
        'Qui veut faire quoi, et pour quoi faire.',
        '',
        '### Comportement attendu',
        '',
        '### Critères d\'acceptation',
        '- ',
        '',
        '### Hors périmètre',
      ].join('\n'),
    },
  },
  {
    slug: 'bug',
    fields: {
      name: 'Bug',
      order: 3,
      priority: 'high',
      labels: ['bug'],
      subtasks: [{ title: 'Écrire un test qui reproduit le bug', done: false }],
      description: [
        '### Contexte',
        'Où ça se passe (écran, fichier, commande) et depuis quand.',
        '',
        '### Étapes pour reproduire',
        '1. …',
        '',
        '### Comportement attendu',
        '',
        '### Comportement observé',
      ].join('\n'),
    },
  },
  {
    slug: 'refacto',
    fields: {
      name: 'Refacto',
      order: 4,
      priority: 'none',
      labels: ['refactor'],
      subtasks: [],
      description: [
        '### Contexte',
        'Pourquoi refactorer maintenant.',
        '',
        '### Problème actuel',
        'Ce qui gêne dans le code tel qu’il est.',
        '',
        '### Cible',
        'À quoi le code doit ressembler après.',
        '',
        '### Contraintes',
        'Comportement inchangé, tests existants à garder verts…',
      ].join('\n'),
    },
  },
]

const FIELD_KEYS = ['name', 'order', 'description', 'priority', 'labels', 'subtasks']
const invalid = (what: string): Error => new Error(`${what} invalide`)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function assertTemplateSlug(s: unknown): asserts s is string {
  if (typeof s !== 'string' || !TEMPLATE_SLUG_RE.test(s)) throw invalid('Modèle')
}

/** Validates template fields received over IPC; unknown keys are refused and the result is a clean copy. */
export function parseTemplateFields(raw: unknown): TemplateFields {
  if (!isObject(raw)) throw invalid('Modèle')
  for (const k of Object.keys(raw)) if (!FIELD_KEYS.includes(k)) throw invalid(`Champ ${k}`)
  const { name, order, description, priority, labels, subtasks } = raw
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_TEMPLATE_NAME) throw invalid('Nom')
  if (order !== undefined && !Number.isInteger(order)) throw invalid('Ordre')
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) throw invalid('Description')
  if (!PRIORITIES.includes(priority as TicketPriority)) throw invalid('Priorité')
  if (!Array.isArray(labels) || labels.length > MAX_LABELS || labels.some((l) => typeof l !== 'string' || l === '' || l.length > MAX_LABEL)) throw invalid('Étiquette')
  if (!Array.isArray(subtasks) || subtasks.length > MAX_SUBTASKS ||
    subtasks.some((s) => !isObject(s) || typeof s.title !== 'string' || s.title.length > MAX_TITLE || typeof s.done !== 'boolean')) throw invalid('Sous-tâche')
  const out: TemplateFields = {
    name, description, priority: priority as TicketPriority, labels: [...(labels as string[])],
    subtasks: (subtasks as { title: string; done: boolean }[]).map((s) => ({ title: s.title, done: s.done }))
  }
  if (order !== undefined) out.order = order as number
  return out
}
