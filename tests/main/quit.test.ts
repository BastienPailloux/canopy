import { expect, test, vi } from 'vitest'
import { createQuitFlow, parseUnsaved, quitDetail, updateDetail, type RunningCounts } from '../../src/main/quit'

const NONE = { sessions: 0, terminals: 0, buffers: 0, drafts: 0, tickets: 0, linear: 0 }

function setup(partial: Partial<RunningCounts>, answer = true) {
  const counts = { ...NONE, ...partial }
  const calls: string[] = []
  const confirm = vi.fn(async () => answer)
  const flow = createQuitFlow({
    counts: () => counts,
    confirm,
    shutdown: () => { calls.push('shutdown') },
    quit: () => { calls.push('quit') }
  })
  return { flow, calls, confirm }
}

test('nothing running quits without asking', async () => {
  const h = setup({ sessions: 0, terminals: 0 })
  await h.flow.request()
  expect(h.confirm).not.toHaveBeenCalled()
  expect(h.calls).toEqual(['shutdown', 'quit'])
  expect(h.flow.quitting).toBe(true)
})

test('something running asks once with the counts, then stops everything and quits', async () => {
  const h = setup({ sessions: 2, terminals: 1 })
  await h.flow.request()
  expect(h.confirm).toHaveBeenCalledOnce()
  expect(h.confirm).toHaveBeenCalledWith({ ...NONE, sessions: 2, terminals: 1 })
  expect(h.calls).toEqual(['shutdown', 'quit'])
})

test('cancel keeps everything running and the app open', async () => {
  const h = setup({ sessions: 1, terminals: 0 }, false)
  await h.flow.request()
  expect(h.calls).toEqual([])
  expect(h.flow.quitting).toBe(false)
})

test('a second request while the question is open does not ask again', async () => {
  const h = setup({ sessions: 1, terminals: 0 })
  await Promise.all([h.flow.request(), h.flow.request()])
  expect(h.confirm).toHaveBeenCalledOnce()
  expect(h.calls).toEqual(['shutdown', 'quit'])
})

test('once quitting, further requests (window close events) do nothing', async () => {
  const h = setup({ sessions: 0, terminals: 0 })
  await h.flow.request()
  await h.flow.request()
  expect(h.calls).toEqual(['shutdown', 'quit'])
})

test('the question lists the counts', () => {
  expect(quitDetail({ ...NONE, sessions: 2, terminals: 1 })).toBe('Quitter arrêtera : 2 sessions Claude en cours, 1 terminal actif.')
  expect(quitDetail({ ...NONE, sessions: 1, terminals: 0 })).toBe('Quitter arrêtera : 1 session Claude en cours.')
  expect(quitDetail({ ...NONE, sessions: 0, terminals: 3 })).toBe('Quitter arrêtera : 3 terminaux actifs.')
})

test('unsaved work alone asks before quitting', async () => {
  for (const unsaved of [{ buffers: 1 }, { drafts: 1 }, { tickets: 1 }]) {
    const h = setup(unsaved, false)
    await h.flow.request()
    expect(h.confirm).toHaveBeenCalledOnce()
    expect(h.calls).toEqual([])
  }
})

test('the question says what stops and what is lost', () => {
  expect(quitDetail({ ...NONE, buffers: 2, drafts: 1 })).toBe('Seront perdus : 2 fichiers non enregistrés, 1 brouillon de message.')
  expect(quitDetail({ ...NONE, tickets: 1 })).toBe('Sera perdu : 1 ticket pas encore enregistré.')
  expect(quitDetail({ ...NONE, buffers: 1, tickets: 2 })).toBe('Seront perdus : 1 fichier non enregistré, 2 tickets pas encore enregistrés.')
  expect(quitDetail({ sessions: 1, terminals: 0, buffers: 1, drafts: 0, tickets: 0, linear: 0 })).toBe('Quitter arrêtera : 1 session Claude en cours. Sera perdu : 1 fichier non enregistré.')
})

test('finish stops everything and hands over without asking', () => {
  const h = setup({ sessions: 1 }); const then = vi.fn()
  h.flow.finish(then)
  expect(h.confirm).not.toHaveBeenCalled(); expect(h.calls).toEqual(['shutdown']); expect(then).toHaveBeenCalledOnce()
  expect(h.flow.quitting).toBe(true)
})
test('update detail says what stops and that edits are kept', () => {
  expect(updateDetail({ sessions: 2, terminals: 1, buffers: 3, drafts: 1, tickets: 0, linear: 0 })).toBe(
    'Redémarrer arrêtera : 2 sessions Claude en cours, 1 terminal actif. Les fichiers non enregistrés et les brouillons seront conservés.')
})

test('update detail says unwritten ticket edits are written first, and lost if that fails', () => {
  expect(updateDetail({ ...NONE, tickets: 1 })).toBe(
    'Les fichiers non enregistrés et les brouillons seront conservés. 1 ticket pas encore enregistré le sera avant le redémarrage ; en cas d’échec, ses modifications seront perdues.')
  expect(updateDetail({ ...NONE, tickets: 2 })).toBe(
    'Les fichiers non enregistrés et les brouillons seront conservés. 2 tickets pas encore enregistrés le seront avant le redémarrage ; en cas d’échec, leurs modifications seront perdues.')
})

test('finish while the quit question is open: a later confirm does not stop or quit again', async () => {
  const counts = { ...NONE, sessions: 1 }
  const calls: string[] = []
  let answer: (ok: boolean) => void = () => {}
  const flow = createQuitFlow({
    counts: () => counts,
    confirm: () => new Promise<boolean>((resolve) => { answer = resolve }),
    shutdown: () => { calls.push('shutdown') },
    quit: () => { calls.push('quit') }
  })
  const asked = flow.request()
  flow.finish(() => { calls.push('then') })
  answer(true)
  await asked
  expect(calls).toEqual(['shutdown', 'then'])
})

test('finish twice stops and hands over once', () => {
  const h = setup({ sessions: 1 }); const then = vi.fn()
  h.flow.finish(then)
  h.flow.finish(then)
  expect(h.calls).toEqual(['shutdown']); expect(then).toHaveBeenCalledOnce()
})

test('update detail with nothing running keeps only the sentence about edits', () => {
  expect(updateDetail(NONE)).toBe('Les fichiers non enregistrés et les brouillons seront conservés.')
})

test('parseUnsaved takes the ticket count and refuses a bad one', () => {
  expect(parseUnsaved({ buffers: 1, drafts: 0, tickets: 2 })).toEqual({ buffers: 1, drafts: 0, tickets: 2 })
  expect(() => parseUnsaved({ buffers: 1, drafts: 0, tickets: -1 })).toThrow()
  expect(() => parseUnsaved({ buffers: 1, drafts: 0 })).toThrow()
})

test('pending Linear edits ask before quitting, and say they stay queued', async () => {
  const h = setup({ linear: 2 }, false)
  await h.flow.request()
  expect(h.confirm).toHaveBeenCalledOnce()
  expect(h.calls).toEqual([])
  expect(quitDetail({ ...NONE, linear: 1 })).toBe('Des modifications Linear n\'ont pas été envoyées. Elles restent en attente et partiront dès que Linear sera joignable.')
  expect(quitDetail({ ...NONE, linear: 2, buffers: 1 })).toBe(
    'Sera perdu : 1 fichier non enregistré. Des modifications Linear n\'ont pas été envoyées. Elles restent en attente et partiront dès que Linear sera joignable.')
})
