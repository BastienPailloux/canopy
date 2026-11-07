import { describe, expect, it, vi } from 'vitest'
import { requestRestart } from '../../src/renderer/update/UpdateBanner'

describe('requestRestart', () => {
  it('disables the button while asking, and enables it again once the user cancels', async () => {
    const setAsked = vi.fn()
    let answer: () => void = () => {}
    requestRestart(setAsked, () => new Promise<void>((r) => { answer = r }))
    expect(setAsked.mock.calls).toEqual([[true]])
    answer()
    await vi.waitFor(() => expect(setAsked.mock.calls).toEqual([[true], [false]]))
    requestRestart(setAsked, () => Promise.resolve())
    await vi.waitFor(() => expect(setAsked.mock.calls).toEqual([[true], [false], [true], [false]]))
  })

  it('enables it again when the call fails', async () => {
    const setAsked = vi.fn()
    requestRestart(setAsked, () => Promise.reject(new Error('x')))
    await vi.waitFor(() => expect(setAsked).toHaveBeenLastCalledWith(false))
  })
})
