import type { UpdateState } from '../../shared/update'

/** The forced restart comes this long after the first download, whatever comes later. */
export const FORCE_AFTER_MS = 24 * 3600_000
/** The warning shows this long before the restart, and always gets its full length, even after a sleep. */
export const WARNING_MS = 10 * 60_000

export interface Schedule {
  /** A download finished. The first one starts the clock; a newer version only replaces the name. */
  downloaded(version: string, now: number): void
  /** Called every 30 s and on wake. The caller restarts once `restartAt <= now`. */
  tick(now: number): UpdateState
  state(): UpdateState
}

export function createSchedule(): Schedule {
  let version: string | undefined
  let deadline = 0
  // Fixed on the first tick in the warning window, so a later wake cannot move it.
  let restartAt: number | undefined
  let current: UpdateState = { phase: 'none' }

  return {
    downloaded(v, now) {
      if (version === undefined) deadline = now + FORCE_AFTER_MS
      version = v
    },
    tick(now) {
      if (version === undefined) current = { phase: 'none' }
      else if (now < deadline - WARNING_MS) current = { phase: 'ready', version, deadline }
      else {
        restartAt ??= Math.max(deadline, now + WARNING_MS)
        current = { phase: 'warning', version, restartAt }
      }
      return current
    },
    state() { return current }
  }
}
