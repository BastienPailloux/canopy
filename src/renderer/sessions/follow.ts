/** Within this distance of the end, the list keeps following what arrives. */
export const FOLLOW_PX = 48

export interface ScrollPosition {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Whether a render should still scroll the list to its end. `autoTop` is where the last
 * follow left the scroll: the scroll event fires on the next frame, so a render can come
 * first and must not pull the user back down from where they just scrolled to.
 */
export function stillFollowing(following: boolean, pos: ScrollPosition, autoTop: number | undefined): boolean {
  if (!following) return false
  if (pos.scrollHeight - pos.scrollTop - pos.clientHeight < FOLLOW_PX) return true
  return autoTop === undefined || pos.scrollTop > autoTop - FOLLOW_PX
}
