import type { TicketFields, TicketTemplate } from '../../shared/tickets'

export type DraftContent = Pick<TicketFields, 'description' | 'priority' | 'labels' | 'subtasks'>

/** Content a template gives a draft; `null` is « Aucun ». Always fresh arrays, so editing the draft never mutates the template. */
export function templateContent(t: TicketTemplate | null): DraftContent {
  if (!t) return { description: '', priority: 'none', labels: [], subtasks: [] }
  return {
    description: t.description,
    priority: t.priority,
    labels: [...t.labels],
    subtasks: t.subtasks.map(s => ({ title: s.title, done: false }))
  }
}

/** Replaces the template-driven fields; the title and the rest of the draft are kept. */
export function applyTemplate<T extends TicketFields>(draft: T, t: TicketTemplate | null): T {
  return { ...draft, ...templateContent(t), status: 'backlog' }
}

/** True while the draft still equals what the template applied (a changed priority counts as an edit). */
export function isUntouched(draft: TicketFields, applied: DraftContent): boolean {
  return draft.description === applied.description
    && draft.priority === applied.priority
    && draft.labels.length === applied.labels.length
    && draft.labels.every((l, i) => l === applied.labels[i])
    && draft.subtasks.length === applied.subtasks.length
    && draft.subtasks.every((s, i) => s.title === applied.subtasks[i].title && s.done === applied.subtasks[i].done)
}

/**
 * Fired on `window` once the templates screen has written: the drafts read the templates again right away,
 * without waiting for the watcher's debounced `tickets:changed`.
 */
export const TEMPLATES_CHANGED = 'canopy:templates-changed'
