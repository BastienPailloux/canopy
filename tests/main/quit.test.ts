import { expect, test, vi } from 'vitest'
import { createQuitFlow, quitDetail, type RunningCounts } from '../../src/main/quit'

const NONE = { sessions: 0, terminals: 0, buffers: 0, drafts: 0 }

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
  for (const unsaved of [{ buffers: 1 }, { drafts: 1 }]) {
    const h = setup(unsaved, false)
    await h.flow.request()
    expect(h.confirm).toHaveBeenCalledOnce()
    expect(h.calls).toEqual([])
  }
})

test('the question says what stops and what is lost', () => {
  expect(quitDetail({ ...NONE, buffers: 2, drafts: 1 })).toBe('Seront perdus : 2 fichiers non enregistrés, 1 brouillon de message.')
  expect(quitDetail({ sessions: 1, terminals: 0, buffers: 1, drafts: 0 })).toBe('Quitter arrêtera : 1 session Claude en cours. Sera perdu : 1 fichier non enregistré.')
})
