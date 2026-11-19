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
  for (const c of clicks) {
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
