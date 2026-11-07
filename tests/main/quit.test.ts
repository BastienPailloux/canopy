import { expect, test, vi } from 'vitest'
import { createQuitFlow, quitDetail, type RunningCounts } from '../../src/main/quit'

function setup(counts: RunningCounts, answer = true) {
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
  expect(h.confirm).toHaveBeenCalledWith({ sessions: 2, terminals: 1 })
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
  expect(quitDetail({ sessions: 2, terminals: 1 })).toBe('Quitter arrêtera : 2 sessions Claude en cours, 1 terminal actif.')
  expect(quitDetail({ sessions: 1, terminals: 0 })).toBe('Quitter arrêtera : 1 session Claude en cours.')
  expect(quitDetail({ sessions: 0, terminals: 3 })).toBe('Quitter arrêtera : 3 terminaux actifs.')
})
