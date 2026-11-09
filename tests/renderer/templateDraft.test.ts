import { describe, expect, it } from 'vitest'
import { applyTemplate, isUntouched, templateContent } from '../../src/renderer/tickets/templateDraft'
import type { TicketFields, TicketTemplate } from '../../src/shared/tickets'

const template: TicketTemplate = {
  slug: 'bug', name: 'Bug', description: 'Étapes', priority: 'high', labels: ['bug'],
  subtasks: [{ title: 'Reproduire', done: true }]
}
const draft: TicketFields = {
  title: 'Mon titre', description: 'x', status: 'todo', priority: 'low', labels: ['a'], subtasks: [], branch: 'feat/x'
}

describe('applyTemplate', () => {
  it('keeps the title and other fields, sets content and backlog', () => {
    const out = applyTemplate(draft, template)
    expect(out).toEqual({
      title: 'Mon titre', description: 'Étapes', status: 'backlog', priority: 'high', labels: ['bug'],
      subtasks: [{ title: 'Reproduire', done: false }], branch: 'feat/x'
    })
  })
  it('does not share arrays with the template', () => {
    const out = applyTemplate(draft, template)
    expect(out.labels).not.toBe(template.labels)
    expect(out.subtasks).not.toBe(template.subtasks)
    expect(out.subtasks[0]).not.toBe(template.subtasks[0])
  })
  it('null empties the content', () => {
    expect(applyTemplate(draft, null)).toMatchObject({ title: 'Mon titre', description: '', priority: 'none', labels: [], subtasks: [], status: 'backlog' })
    expect(templateContent(null)).toEqual({ description: '', priority: 'none', labels: [], subtasks: [] })
  })
})

describe('isUntouched', () => {
  const applied = templateContent(template)
  const fresh = () => applyTemplate(draft, template)
  it('is true right after applyTemplate', () => expect(isUntouched(fresh(), applied)).toBe(true))
  it('ignores the title', () => expect(isUntouched({ ...fresh(), title: 'autre' }, applied)).toBe(true))
  it('is false after editing description, a label, priority or a subtask', () => {
    expect(isUntouched({ ...fresh(), description: 'y' }, applied)).toBe(false)
    expect(isUntouched({ ...fresh(), labels: ['bug', 'z'] }, applied)).toBe(false)
    expect(isUntouched({ ...fresh(), priority: 'low' }, applied)).toBe(false)
    expect(isUntouched({ ...fresh(), subtasks: [{ title: 'Reproduire', done: true }] }, applied)).toBe(false)
  })
})
