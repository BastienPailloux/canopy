import { describe, expect, it, vi } from 'vitest'
import type { LinearChange, LinearIssue, LinearIssueDetail, PendingEdit, SaveResult } from '../../src/shared/linear'
import { closeLinearSaver, conflictHint, createLinearSaver, openLinearSaver, unsavedLinear } from '../../src/renderer/tickets/linearSave'

const ISSUE: LinearIssueDetail = {
  id: 'ENG-1', uuid: 'u1', title: 'Titre', description: 'Avant\n', url: 'https://linear.app/x/issue/ENG-1',
  status: { id: null, name: 'Todo', type: 'unstarted' }, priority: 'none', labels: [], assignee: null,
  team: { id: 't1', name: 'Eng' }, parentId: null, cycle: null, project: null, updatedAt: '2026-11-08T10:00:00Z',
  children: [], comments: []
}

const answer = (over: Partial<LinearIssue>): LinearIssue => ({ ...ISSUE, ...over })

function setup(reply: (c: LinearChange) => SaveResult = (c) => ({
  kind: 'sent', issue: answer({ title: c.title ?? ISSUE.title, description: c.description?.text ?? ISSUE.description })
})) {
  const send = vi.fn(async (c: LinearChange) => reply(c))
  return { send, saver: createLinearSaver('ENG-1', ISSUE, send) }
}

describe('createLinearSaver', () => {
  it('text is not sent while typing', async () => {
    const { send, saver } = setup()
    for (let i = 1; i <= 10; i++) saver.text('description', `Avant ${'x'.repeat(i)}`)
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(saver.dirty()).toBe(true)
  })

  it('blur sends the description once with its base', async () => {
    const { send, saver } = setup()
    saver.text('description', 'Avant\nAprès')
    saver.text('description', 'Avant\nAprès !')
    const r = await saver.commit('description')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ description: { base: 'Avant\n', text: 'Avant\nAprès !' } })
    expect(r?.kind).toBe('sent')
    expect(saver.dirty()).toBe(false)
    // Nothing changed since: a second blur sends nothing.
    expect(await saver.commit('description')).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the next base is Linear\'s answer, not the text sent', async () => {
    const { send, saver } = setup((c) => ({ kind: 'sent', issue: answer({ description: `${c.description?.text ?? ''}\n` }) }))
    saver.text('description', 'Deux')
    await saver.commit('description')
    expect(saver.value('description')).toBe('Deux\n')
    saver.text('description', 'Trois')
    await saver.commit('description')
    expect(send).toHaveBeenLastCalledWith({ description: { base: 'Deux\n', text: 'Trois' } })
  })

  it('field changes are sent at once', async () => {
    const { send, saver } = setup()
    const results: SaveResult[] = []
    saver.onResult((r) => { results.push(r) })
    saver.field({ statusId: 's2' })
    saver.field({ labels: ['Bug'] })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, { statusId: 's2' })
    expect(send).toHaveBeenNthCalledWith(2, { labels: ['Bug'] })
    await vi.waitFor(() => expect(results).toHaveLength(2))
  })

  it('a conflict result keeps the local text dirty', async () => {
    const { send, saver } = setup((c) => ({ kind: 'conflict', field: 'description', remote: 'Collègue\n', mine: c.description?.text ?? '' }))
    saver.text('description', 'Moi')
    const r = await saver.commit('description')
    expect(r?.kind).toBe('conflict')
    expect(saver.dirty()).toBe(true)
    expect(saver.value('description')).toBe('Moi')
    expect(saver.conflict()).toEqual({ remote: 'Collègue\n', mine: 'Moi' })
    // Main holds it: not counted twice, not resent on close.
    expect(saver.unsent()).toBe(false)
    expect(await saver.commit()).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeping mine sends it over Linear\'s version', async () => {
    let n = 0
    const { send, saver } = setup((c) => (n++ === 0
      ? { kind: 'conflict', field: 'description', remote: 'Collègue\n', mine: c.description?.text ?? '' }
      : { kind: 'sent', issue: answer({ description: 'Moi\n' }) }))
    saver.text('description', 'Moi')
    await saver.commit('description')
    const r = await saver.keepMine()
    expect(send).toHaveBeenLastCalledWith({ description: { base: 'Collègue\n', text: 'Moi' } })
    expect(r?.kind).toBe('sent')
    expect(saver.conflict()).toBeNull()
    expect(saver.dirty()).toBe(false)
  })

  it('taking Linear\'s version drops mine and keeps the title being typed', async () => {
    const { send, saver } = setup((c) => ({ kind: 'conflict', field: 'description', remote: 'Collègue\n', mine: c.description?.text ?? '' }))
    saver.text('description', 'Moi')
    await saver.commit('description')
    saver.text('title', 'Je tape')
    saver.takeTheirs()
    expect(saver.conflict()).toBeNull()
    expect(saver.value('description')).toBe('Collègue\n')
    expect(saver.value('title')).toBe('Je tape')
    saver.text('description', 'Collègue\net moi')
    await saver.commit('description')
    expect(send).toHaveBeenLastCalledWith({ description: { base: 'Collègue\n', text: 'Collègue\net moi' } })
  })

  it('close commits title and description', async () => {
    const { send, saver } = setup()
    saver.text('title', 'Nouveau titre')
    saver.text('description', 'Nouveau texte')
    await saver.commit()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ title: 'Nouveau titre', description: { base: 'Avant\n', text: 'Nouveau texte' } })
    expect(saver.dirty()).toBe(false)
  })

  it('an emptied title goes back and is not sent', async () => {
    const { send, saver } = setup()
    saver.text('title', '  ')
    expect(await saver.commit('title')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(saver.value('title')).toBe('Titre')
  })

  it('a pending result is held by main: no longer dirty, base kept for the next edit', async () => {
    const { send, saver } = setup(() => ({ kind: 'pending', reason: 'Réseau indisponible' }))
    saver.text('description', 'Un')
    await saver.commit('description')
    expect(saver.dirty()).toBe(false)
    expect(saver.value('description')).toBe('Un')
    saver.text('description', 'Deux')
    await saver.commit('description')
    expect(send).toHaveBeenLastCalledWith({ description: { base: 'Avant\n', text: 'Deux' } })
  })

  it('a failed send keeps the text dirty', async () => {
    const send = vi.fn(async (): Promise<SaveResult> => { throw new Error('IPC') })
    const saver = createLinearSaver('ENG-1', ISSUE, send)
    saver.text('title', 'Autre')
    const r = await saver.commit('title')
    expect(r).toEqual({ kind: 'pending', reason: 'IPC' })
    expect(saver.dirty()).toBe(true)
    expect(saver.unsent()).toBe(true)
  })

  it('pending text wins over Linear\'s on reset', () => {
    const { saver } = setup()
    const pending: PendingEdit = {
      id: 'ENG-1', change: { title: 'Pas envoyé', description: { base: 'Vieux\n', text: 'Le mien' } }, error: 'Réseau', held: {}, uncertain: false
    }
    saver.reset(answer({ title: 'Linear', description: 'Linear\n' }), pending)
    expect(saver.value('title')).toBe('Pas envoyé')
    expect(saver.value('description')).toBe('Le mien')
    expect(saver.dirty()).toBe(false)
    expect(saver.conflict()).toBeNull()
  })

  it('a held or uncertain description opens the conflict on reset', async () => {
    const { send, saver } = setup()
    saver.reset(answer({ description: 'Collègue\n' }), {
      id: 'ENG-1', change: { description: { base: 'Vieux\n', text: 'Le mien' } }, error: '', held: { description: 'conflit' }, uncertain: false
    })
    expect(saver.conflict()).toEqual({ remote: 'Collègue\n', mine: 'Le mien' })
    await saver.keepMine()
    expect(send).toHaveBeenCalledWith({ description: { base: 'Collègue\n', text: 'Le mien' } })
    saver.reset(answer({ description: 'Collègue\n' }), {
      id: 'ENG-1', change: { description: { base: 'Vieux\n', text: 'Le mien' } }, error: '', held: {}, uncertain: true
    })
    expect(saver.conflict()).toEqual({ remote: 'Collègue\n', mine: 'Le mien' })
  })

  it('an answer to a field updates the text fields not being edited', async () => {
    const { saver } = setup(() => ({ kind: 'sent', issue: answer({ title: 'Renommé', description: 'Collègue\n' }) }))
    saver.text('title', 'Je tape')
    saver.field({ priority: 'high' })
    await vi.waitFor(() => expect(saver.value('description')).toBe('Collègue\n'))
    expect(saver.value('title')).toBe('Je tape')
  })

  it('overlapping side sends answered out of order keep the latest choice and never drop an in-flight label', async () => {
    const answers: ((r: SaveResult) => void)[] = []
    const send = vi.fn((_c: LinearChange) => new Promise<SaveResult>((res) => answers.push(res)))
    const saver = createLinearSaver('ENG-1', ISSUE, send)
    const fresh: boolean[] = []
    saver.onResult((_r, f) => fresh.push(f))
    saver.field({ labels: ['A'] })
    saver.field({ statusId: 's2' })
    answers[1]({ kind: 'sent', issue: answer({ labels: [] }) })
    await vi.waitFor(() => expect(fresh).toHaveLength(1))
    expect(saver.side()).toEqual({ labels: ['A'] })
    saver.field({ labels: [...(saver.side().labels ?? []), 'C'] })
    expect(send).toHaveBeenLastCalledWith({ labels: ['A', 'C'] })
    answers[0]({ kind: 'sent', issue: answer({ labels: ['A'] }) })
    await vi.waitFor(() => expect(fresh).toHaveLength(2))
    expect(fresh[1]).toBe(false)
    expect(saver.side()).toEqual({ labels: ['A', 'C'] })
    answers[2]({ kind: 'sent', issue: answer({ labels: ['A', 'C'] }) })
    await vi.waitFor(() => expect(fresh).toHaveLength(3))
    expect(fresh[2]).toBe(true)
    expect(saver.side()).toEqual({})
  })

  it('a side choice main queued keeps showing until discarded', async () => {
    const { saver } = setup(() => ({ kind: 'pending', reason: 'Réseau' }))
    saver.field({ priority: 'high' })
    await vi.waitFor(() => expect(saver.generation()).toBeGreaterThan(1))
    expect(saver.side()).toEqual({ priority: 'high' })
    saver.resetFields(ISSUE, ['priority'])
    expect(saver.side()).toEqual({})
  })

  it('a read started before a save does not overwrite it', async () => {
    const { send, saver } = setup()
    const readAt = saver.generation()
    saver.text('description', 'V1')
    await saver.commit('description')
    expect(saver.reset(answer({ description: 'V0' }), undefined, readAt)).toBe('kept')
    expect(saver.value('description')).toBe('V1')
    saver.text('description', 'V2')
    await saver.commit('description')
    expect(send).toHaveBeenLastCalledWith({ description: { base: 'V1', text: 'V2' } })
  })

  it('a held text equal to Linear\'s once normalized opens no conflict', () => {
    const { saver } = setup()
    const r = saver.reset(answer({ description: 'Un\nDeux' }), {
      id: 'ENG-1', change: { description: { base: 'Vieux', text: 'Un  \nDeux\n\n' } }, error: '', held: { description: 'conflit' }, uncertain: false
    })
    expect(r).toBe('same')
    expect(saver.conflict()).toBeNull()
    expect(saver.value('description')).toBe('Un\nDeux')
  })

  it('discarding the title leaves the description being typed', () => {
    const { saver } = setup()
    saver.reset(ISSUE, { id: 'ENG-1', change: { title: 'Refusé' }, error: '', held: { title: 'refusé' }, uncertain: false })
    saver.text('description', 'Je tape')
    saver.resetFields(answer({ title: 'Linear', description: 'Autre' }), ['title'])
    expect(saver.value('title')).toBe('Linear')
    expect(saver.value('description')).toBe('Je tape')
    expect(saver.dirty()).toBe(true)
  })

  it('text a close could not send is kept for the next editor of the issue and counted', async () => {
    let fail = true
    const make = () => createLinearSaver('ENG-9', ISSUE, async (c) => {
      if (fail) throw new Error('IPC')
      return { kind: 'sent', issue: answer({ description: c.description?.text ?? '' }) }
    })
    const first = openLinearSaver('ENG-9', make)
    first.text('description', 'Ne pas perdre')
    await closeLinearSaver('ENG-9', first, () => true)
    expect(unsavedLinear()).toBe(1)
    const second = openLinearSaver('ENG-9', make)
    expect(second).toBe(first)
    expect(second.value('description')).toBe('Ne pas perdre')
    fail = false
    await closeLinearSaver('ENG-9', second, () => true)
    expect(unsavedLinear()).toBe(0)
    expect(openLinearSaver('ENG-9', make)).not.toBe(first)
  })
})

describe('conflictHint', () => {
  const entry = (over: Partial<PendingEdit>): PendingEdit => ({ id: 'CAN-1', change: {}, error: '', held: {}, uncertain: false, ...over })
  it('the held reason when there is one', () => {
    expect(conflictHint(entry({ held: { description: 'Linear n’a pas appliqué la modification' } }))).toBe('Linear n’a pas appliqué la modification')
  })
  it('an uncertain resend not checked yet has its own text', () => {
    expect(conflictHint(entry({ uncertain: true, error: 'Linear injoignable : socket hang up' })))
      .toBe('Linear a peut-être déjà reçu cette modification : vérifie les deux versions.')
  })
  it('else a colleague changed the passage', () => {
    expect(conflictHint(undefined)).toBe('Un collègue a modifié le même passage de la description.')
  })
})
