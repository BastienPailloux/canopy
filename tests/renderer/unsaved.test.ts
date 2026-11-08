import { afterEach, expect, it, vi } from 'vitest'
import { createSaver, notifySavers, trackSaver } from '../../src/renderer/tickets/editorSave'
import { connectUnsaved } from '../../src/renderer/unsaved'

afterEach(() => { vi.unstubAllGlobals() })

it('reports the ticket editors holding unwritten changes', async () => {
  const reportUnsaved = vi.fn(async () => {})
  vi.stubGlobal('window', { canopy: { reportUnsaved } })
  const stop = connectUnsaved()
  expect(reportUnsaved).toHaveBeenLastCalledWith({ buffers: 0, drafts: 0, tickets: 0 })
  const saver = createSaver(async () => {}, 60_000, { onPending: notifySavers })
  const untrack = trackSaver(saver)
  saver.change({ title: 'T' })
  expect(reportUnsaved).toHaveBeenLastCalledWith({ buffers: 0, drafts: 0, tickets: 1 })
  await saver.flush()
  expect(reportUnsaved).toHaveBeenLastCalledWith({ buffers: 0, drafts: 0, tickets: 0 })
  untrack()
  saver.dispose()
  stop()
})
