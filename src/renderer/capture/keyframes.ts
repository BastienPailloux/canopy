import { AFTER_CLICK_MS, MAX_RECORDING_FRAMES, type FrameReason } from '../../shared/recording'

/** Mean fingerprint difference above which a screen counts as changed; tuned on real captures. */
export const CHANGE_THRESHOLD = 0.02

export interface Candidate {
  t: number
  reason: FrameReason
  /** The fingerprint diff for `change`, 0 otherwise. */
  score: number
  click?: { x: number; y: number }
}

/** Mean absolute difference of two equal-length grayscale fingerprints, in 0..1. */
export function fingerprintDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length === 0) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / (a.length * 255)
}

/** Ties go to the even index, which keeps the spacing symmetric (10.5 gives 10, 3.5 gives 4). */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** Picks at most `max` frames: edges first, click pairs together, then the biggest changes. */
export function selectKeyFrames<C extends Candidate>(candidates: C[], max = MAX_RECORDING_FRAMES): C[] {
  const sorted = [...candidates].sort((a, b) => a.t - b.t)
  const start = sorted.find(c => c.reason === 'start')
  const end = [...sorted].reverse().find(c => c.reason === 'end')
  const befores = sorted.filter(c => c.reason === 'before-click')
  const afters = sorted.filter(c => c.reason === 'after-click')
  const paired = Math.min(befores.length, afters.length)
  const pairs = Array.from({ length: paired }, (_, i) => [befores[i], afters[i]])
  // A click at the very end of the recording has no after frame: rank it like a change.
  const lone = [...befores.slice(paired), ...afters.slice(paired)].map(c => ({ ...c, score: 0 }))
  const changes = [...sorted.filter(c => c.reason === 'change'), ...lone]

  const kept: C[] = []
  if (start) kept.push(start)
  if (end) kept.push(end)
  const remaining = Math.max(0, max - kept.length)

  let chosen = pairs
  if (pairs.length * 2 > remaining) {
    const k = Math.floor(remaining / 2)
    const n = pairs.length
    chosen = Array.from({ length: k }, (_, i) => pairs[k === 1 ? n - 1 : roundHalfEven(i * (n - 1) / (k - 1))])
  }
  for (const p of chosen) kept.push(...p)

  const room = Math.max(0, max - kept.length)
  const best = [...changes].sort((a, b) => b.score - a.score).slice(0, room)
  return [...kept, ...best].sort((a, b) => a.t - b.t)
}

/**
 * Every candidate of a recording, each pointing at the sample that holds its image.
 * `change` is set on the samples that differed enough from the last kept one; clicks are already in image pixels.
 */
export function recordingCandidates(
  samples: { t: number; change?: number }[],
  clicks: { t: number; x: number; y: number }[]
): (Candidate & { sample: number })[] {
  if (samples.length === 0) return []
  const last = samples.length - 1
  const out: (Candidate & { sample: number })[] = [{ t: samples[0].t, reason: 'start', score: 0, sample: 0 }]
  const used = new Set([0, last])
  // The helper starts before the stream: a click before the first sample has no image of its own.
  for (const c of clicks.filter(c => c.t >= samples[0].t)) {
    const click = { x: c.x, y: c.y }
    const before = samples.findLastIndex(s => s.t <= c.t)
    const after = samples.findIndex(s => s.t >= c.t + AFTER_CLICK_MS)
    if (before >= 0) { out.push({ t: samples[before].t, reason: 'before-click', score: 0, click, sample: before }); used.add(before) }
    if (after >= 0) { out.push({ t: samples[after].t, reason: 'after-click', score: 0, click, sample: after }); used.add(after) }
  }
  // A sample already sent for a click or an edge would only repeat its image.
  samples.forEach((s, i) => { if (s.change !== undefined && !used.has(i)) out.push({ t: s.t, reason: 'change', score: s.change, sample: i }) })
  if (last > 0) out.push({ t: samples[last].t, reason: 'end', score: 0, sample: last })
  return out.sort((a, b) => a.t - b.t)
}

type Point = { x: number; y: number }
type Click = { t: number } & Point

/** Global points within which a click repeats the previous one (a double-click). */
const REPEAT_RADIUS = 8

/** A click within AFTER_CLICK_MS and REPEAT_RADIUS of a kept one shows nothing new: one pair is enough. */
export const isRepeatClick = (prev: Click, c: Click): boolean =>
  c.t >= prev.t && c.t - prev.t <= AFTER_CLICK_MS && Math.hypot(c.x - prev.x, c.y - prev.y) <= REPEAT_RADIUS

/** Samples always held: the newest give a late click its before frame, and the last one is the end. */
const RING = 3

export interface FrameCollector<I> {
  /** A sample in time order; `change` as in `recordingCandidates`. */
  sample(s: { t: number; change?: number; image: I }): void
  /** A click in global points, as it comes; repeats, clicks out of the region and before the first sample are dropped. */
  click(c: Click): void
  /** How many samples are in memory. */
  held(): number
  /** The candidates with their image, the clicks kept, and the first and last sample times. */
  candidates(): { candidates: (Candidate & { image: I })[]; clickCount: number; t0: number; t1: number }
}

/**
 * Keeps, as the recording goes, only the samples a candidate can need: the start, the biggest changes, the frames
 * around each click and the last few. `toImage` maps a click to image pixels, null outside the region.
 */
export function createFrameCollector<I>(toImage: (p: Point) => Point | null): FrameCollector<I> {
  // `keep`: the start or a click's frame, never dropped.
  let held: { t: number; change?: number; image: I; keep: boolean }[] = []
  const kept: Click[] = []
  const clicks: Click[] = []
  let waiting: Click[] = []
  /** Clicks that came before the first sample was in: it may still be the one before them. */
  let early: Click[] = []
  const seen = new Set<string>()
  const prune = (): void => {
    const cut = held.length - RING
    // No more changes than a recording can send: the smallest would never be picked.
    const best = new Set(held.filter((h) => !h.keep && h.change !== undefined)
      .sort((a, b) => (b.change ?? 0) - (a.change ?? 0)).slice(0, MAX_RECORDING_FRAMES))
    held = held.filter((h, i) => h.keep || i >= cut || best.has(h))
  }
  const collector: FrameCollector<I> = {
    sample(s) {
      const h = { ...s, keep: held.length === 0 }
      held.push(h)
      waiting = waiting.filter((c) => {
        if (s.t < c.t + AFTER_CLICK_MS) return true
        h.keep = true
        return false
      })
      prune()
      if (early.length > 0) { const queued = early; early = []; for (const c of queued) collector.click(c) }
    },
    click(c) {
      if (held.length === 0) { early.push(c); return }
      const key = `${c.t},${c.x},${c.y}`
      if (seen.has(key)) return
      seen.add(key)
      // The helper starts before the stream: a click before the first sample has no image of its own.
      if (c.t < held[0].t) return
      const p = toImage(c)
      if (!p || kept.some((k) => isRepeatClick(k, c))) return
      kept.push(c)
      clicks.push({ t: c.t, ...p })
      const before = held.findLast((h) => h.t <= c.t)
      if (before) before.keep = true
      const after = held.find((h) => h.t >= c.t + AFTER_CLICK_MS)
      if (after) after.keep = true
      else waiting.push(c)
    },
    held: () => held.length,
    candidates() {
      // What was dropped is neither a click's frame, the start nor the end, only changes too small to be picked.
      const candidates = recordingCandidates(held, clicks).map((c) => ({ ...c, image: held[c.sample].image }))
      return { candidates, clickCount: clicks.length, t0: held[0]?.t ?? 0, t1: held[held.length - 1]?.t ?? 0 }
    }
  }
  return collector
}
