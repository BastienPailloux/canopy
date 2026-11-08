import { beforeEach, expect, test, vi } from 'vitest'
import { answerFor, ensureBranchBase, resetBranchBases, useBranchBases } from '../../src/renderer/code/branchBaseStore'

const branchBase = vi.fn()
beforeEach(() => {
  resetBranchBases()
  branchBase.mockReset()
  ;(globalThis as unknown as { window: unknown }).window = { canopy: { branchBase } }
})
const settle = (): Promise<void> => new Promise((r) => setTimeout(r))

test('one IPC call per key; a lost base is served to a second consumer', async () => {
  branchBase.mockResolvedValueOnce({ lost: 'feat/gone' }).mockResolvedValue(null)
  ensureBranchBase('/w', 'feat/a')
  ensureBranchBase('/w', 'feat/a')
  await settle()
  ensureBranchBase('/w', 'feat/a')
  expect(branchBase).toHaveBeenCalledTimes(1)
  expect(answerFor(useBranchBases.getState().answers, '/w', 'feat/a')).toEqual({ base: null, lost: 'feat/gone' })
})

test('a new branch label asks again, and a failure is retried', async () => {
  branchBase.mockRejectedValueOnce(new Error('x')).mockResolvedValue({ base: 'feat/p' })
  ensureBranchBase('/w', 'feat/a')
  await settle()
  ensureBranchBase('/w', 'feat/a')
  await settle()
  expect(answerFor(useBranchBases.getState().answers, '/w', 'feat/a').base).toBe('feat/p')
  ensureBranchBase('/w', 'feat/b')
  expect(branchBase).toHaveBeenCalledTimes(3)
})
