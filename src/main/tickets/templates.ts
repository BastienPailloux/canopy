import { Document, isSeq } from 'yaml'
import { PRIORITIES, type TemplateFields, type TicketPriority, type TicketTemplate } from '../../shared/tickets'
import { splitBody, splitFrontMatter } from './format'

const SUBTASKS_HEADING = '## Sous-tâches'

/** Throws when the front matter is missing or invalid. */
export function parseTemplate(text: string, slug: string): TicketTemplate {
  const { data, body } = splitFrontMatter(text)
  if (typeof data.name !== 'string' || !data.name) throw new Error('Champ « name » invalide')
  const priority = data.priority ?? 'none'
  if (!PRIORITIES.includes(priority as TicketPriority)) throw new Error(`Priorité inconnue : ${String(priority)}`)
  const labels = data.labels ?? []
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' && typeof l !== 'number')) throw new Error('Champ « labels » invalide')
  const { description, subtasks } = splitBody(body)
  const t: TicketTemplate = { slug, name: data.name, description, priority: priority as TicketPriority, labels: labels.map(String), subtasks }
  if (typeof data.order === 'number' && Number.isFinite(data.order)) t.order = data.order
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
