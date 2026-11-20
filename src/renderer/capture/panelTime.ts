import { MAX_RECORDING_MS } from '../../shared/recording'

/** The panel turns red for the last 10 seconds. */
const WARNING_MS = 10_000

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** `0:12 / 2:00`, capped at the limit: the timer may fire a little late. */
export function formatPanelTime(elapsedMs: number): { text: string; warning: boolean } {
  const elapsed = Math.min(Math.max(0, elapsedMs), MAX_RECORDING_MS)
  return { text: `${clock(elapsed)} / ${clock(MAX_RECORDING_MS)}`, warning: elapsed >= MAX_RECORDING_MS - WARNING_MS }
}

/** 0 until main acknowledges the start: the panel then counts from the same origin as main's timer. */
export function panelElapsed(startedAt: number | null, now: number): number {
  return startedAt === null ? 0 : now - startedAt
}
