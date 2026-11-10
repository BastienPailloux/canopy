import { describe, expect, it } from 'vitest'
import { FOLLOW_PX, stillFollowing } from '../../src/renderer/sessions/follow'

// A 500px viewport: at the end, scrollTop = scrollHeight - 500.
const at = (scrollTop: number, scrollHeight: number) => ({ scrollTop, scrollHeight, clientHeight: 500 })

describe('stillFollowing', () => {
  it('stops when the list was not following', () => {
    expect(stillFollowing(false, at(1500, 2000), 1500)).toBe(false)
  })

  it('follows on the first render', () => {
    expect(stillFollowing(true, at(0, 2000), undefined)).toBe(true)
  })

  it('keeps following when content grew below the last end it scrolled to', () => {
    expect(stillFollowing(true, at(1500, 3000), 1500)).toBe(true)
  })

  it('stops when the user scrolled up and the scroll event has not reported it yet', () => {
    expect(stillFollowing(true, at(0, 3000), 1500)).toBe(false)
  })

  it('keeps following after a scroll shorter than the follow distance', () => {
    expect(stillFollowing(true, at(1500 - FOLLOW_PX + 1, 3000), 1500)).toBe(true)
  })

  it('keeps following when shrinking content pulled the scroll back to the end', () => {
    expect(stillFollowing(true, at(1000, 1500), 1500)).toBe(true)
  })
})
