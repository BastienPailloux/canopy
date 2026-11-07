import type { AppUpdater, UpdateDownloadedEvent } from 'electron-updater'
import type { Stash, UpdateState } from '../../shared/update'
import { updateDetail, type RunningCounts } from '../quit'
import { createSchedule } from './schedule'
import { parseStash, writeStash } from './stash'

const CHECK_EVERY_MS = 4 * 3600_000
const TICK_EVERY_MS = 30_000

export interface UpdaterDeps {
  updater: Pick<AppUpdater, 'checkForUpdates' | 'quitAndInstall' | 'on' | 'autoDownload' | 'autoInstallOnAppQuit'>
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  broadcast: (event: string, payload?: unknown) => void
  counts: () => RunningCounts
  /** Asks the user; resolves true to restart. */
  confirm: (detail: string) => Promise<boolean>
  /** Stops everything without asking, then runs `then` instead of quitting. */
  finish: (then: () => void) => void
  stashFile: string
  /** How long the page gets to hand over its unsaved work before the restart goes on without it. */
  stashTimeoutMs: number
}

export interface Updater {
  start(): void
  state(): UpdateState
  /** Recomputes the state now: every 30 s, and on wake. */
  tick(): void
  restart(byUser: boolean): Promise<void>
  /** The page's answer to `update:collectStash`. */
  receiveStash(raw: unknown): void
}

const logError = (e: unknown): void => { console.error('[update]', e) }

/**
 * Downloads updates in the background and restarts into them: when the user asks, or on its own at the deadline.
 * Before restarting it asks the page for its unsaved work and sets it aside on disk; a page that does not answer
 * in time is not waited for.
 */
export function createUpdater(deps: UpdaterDeps): Updater {
  const schedule = createSchedule()
  let last = JSON.stringify(schedule.state())
  // Set once the restart is under way: nothing can stop or repeat it.
  let restarting = false
  let asking = false
  let deliver: ((s: Stash | null) => void) | undefined

  const tick = (): void => {
    const now = deps.now()
    const s = schedule.tick(now)
    const json = JSON.stringify(s)
    if (json !== last) {
      last = json
      deps.broadcast('update:state', s)
    }
    if (s.phase === 'warning' && s.restartAt <= now) void restart(false)
  }

  const collectStash = (): Promise<Stash | null> => new Promise((resolve) => {
    const timer = setTimeout(() => { deliver = undefined; resolve(null) }, deps.stashTimeoutMs)
    deliver = (s) => { clearTimeout(timer); deliver = undefined; resolve(s) }
    deps.broadcast('update:collectStash')
  })

  async function restart(byUser: boolean): Promise<void> {
    if (restarting || schedule.state().phase === 'none') return
    if (byUser) {
      // A forced restart may still come while the question is open: it goes on, and the answer no longer matters.
      if (asking) return
      const counts = deps.counts()
      if (counts.sessions + counts.terminals > 0) {
        asking = true
        try {
          if (!(await deps.confirm(updateDetail(counts)))) return
        } finally {
          asking = false
        }
        if (restarting) return
      }
    }
    restarting = true
    const stash = await collectStash()
    if (stash) {
      try { writeStash(deps.stashFile, stash) } catch (e) { logError(e) }
    }
    deps.finish(() => { deps.updater.quitAndInstall(false, true) })
  }

  return {
    start() {
      const u = deps.updater
      u.autoDownload = true
      u.autoInstallOnAppQuit = true
      u.on('error', logError)
      u.on('update-downloaded', (info: UpdateDownloadedEvent) => {
        schedule.downloaded(info.version, deps.now())
        tick()
      })
      const check = (): void => {
        try { u.checkForUpdates().catch(logError) } catch (e) { logError(e) }
      }
      check()
      deps.setInterval(check, CHECK_EVERY_MS)
      deps.setInterval(tick, TICK_EVERY_MS)
    },
    state: () => schedule.state(),
    tick,
    restart,
    receiveStash(raw) {
      if (!deliver) return
      let s: Stash | null = null
      try { s = parseStash(raw) } catch (e) { logError(e) }
      deliver(s)
    }
  }
}
