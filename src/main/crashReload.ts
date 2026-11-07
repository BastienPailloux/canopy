const WINDOW_MS = 60_000
const MAX_RELOADS = 3

/**
 * Decides on a dead renderer: sessions and terminals live in the main process, so a reload gets the window back.
 * A page crashing as soon as it loads would loop for ever: past three reloads in a minute, it stays down.
 */
export function createCrashReload(now: () => number = Date.now): (reason: string) => boolean {
  let reloads: number[] = []
  return (reason) => {
    if (reason === 'clean-exit') return false
    const at = now()
    reloads = reloads.filter((t) => at - t < WINDOW_MS)
    if (reloads.length >= MAX_RELOADS) return false
    reloads.push(at)
    return true
  }
}
