import { type DraftContent, templateContent, type TicketFields, type TicketTemplate } from '../../shared/tickets'

export { type DraftContent, templateContent }

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
