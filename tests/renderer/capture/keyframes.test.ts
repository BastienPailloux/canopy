import { describe, expect, it } from 'vitest'
import { createFrameCollector, fingerprintDiff, isRepeatClick, recordingCandidates, selectKeyFrames, type Candidate } from '../../../src/renderer/capture/keyframes'

const click = { x: 1, y: 2 }
const clicks = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => [
    { t: 1000 + i * 1000, reason: 'before-click' as const, score: 0, click },
    { t: 1000 + i * 1000 + 500, reason: 'after-click' as const, score: 0, click }
  ]).flat()
const edges = (): Candidate[] => [
  { t: 0, reason: 'start', score: 0 },
  { t: 100000, reason: 'end', score: 0 }
]

describe('fingerprintDiff', () => {
  it('is 1 for opposite fingerprints and 0 for identical ones', () => {
    expect(fingerprintDiff(new Uint8ClampedArray([0, 0]), new Uint8ClampedArray([255, 255]))).toBe(1)
    expect(fingerprintDiff(new Uint8ClampedArray([7, 9]), new Uint8ClampedArray([7, 9]))).toBe(0)
  })
})

describe('selectKeyFrames', () => {
  it('returns nothing for no candidates and the start alone', () => {
    expect(selectKeyFrames([])).toEqual([])
    const start: Candidate = { t: 0, reason: 'start', score: 0 }
    expect(selectKeyFrames([start])).toEqual([start])
  })

  it('keeps edges and click pairs, then the best changes, sorted by t', () => {
    const changes: Candidate[] = Array.from({ length: 30 }, (_, i) => ({ t: 10 + i * 10, reason: 'change', score: i / 100 }))
    const out = selectKeyFrames([...changes, ...clicks(3), ...edges()], 20)
    expect(out).toHaveLength(20)
    expect(out.filter(c => c.reason !== 'change')).toHaveLength(8)
    const kept = out.filter(c => c.reason === 'change').map(c => c.score).sort((a, b) => a - b)
    expect(kept[0]).toBeCloseTo(0.18)
    expect(kept[11]).toBeCloseTo(0.29)
    expect(out.map(c => c.t)).toEqual([...out.map(c => c.t)].sort((a, b) => a - b))
  })

  it('spaces click pairs evenly when they do not all fit, never splitting a pair', () => {
    const out = selectKeyFrames([...clicks(15), ...edges()], 20)
    expect(out).toHaveLength(20)
    const pairs = out.filter(c => c.reason === 'before-click').map(c => (c.t - 1000) / 1000)
    expect(pairs).toEqual([0, 2, 4, 5, 7, 9, 10, 12, 14])
    expect(out.filter(c => c.reason === 'after-click')).toHaveLength(9)
    expect(out[0].reason).toBe('start')
    expect(out[19].reason).toBe('end')
  })

  it('treats a trailing before-click without its after-click as a lone change of score 0', () => {
    const lone: Candidate = { t: 50, reason: 'before-click', score: 0, click }
    const out = selectKeyFrames([...edges(), lone], 2)
    expect(out.map(c => c.reason)).toEqual(['start', 'end'])
    expect(selectKeyFrames([...edges(), lone])).toContainEqual(lone)
  })
})

describe('recordingCandidates', () => {
  // A sample every 250 ms from t = 1000.
  const samples = (n: number, changes: Record<number, number> = {}) =>
    Array.from({ length: n }, (_, i) => ({ t: 1000 + i * 250, ...(i in changes ? { change: changes[i] } : {}) }))

  it('is empty without samples', () => {
    expect(recordingCandidates([], [{ t: 1000, x: 1, y: 2 }])).toEqual([])
  })

  it('takes the first sample as start, the last as end and the kept changes', () => {
    expect(recordingCandidates(samples(4, { 2: 0.1 }), [])).toEqual([
      { t: 1000, reason: 'start', score: 0, sample: 0 },
      { t: 1500, reason: 'change', score: 0.1, sample: 2 },
      { t: 1750, reason: 'end', score: 0, sample: 3 }
    ])
  })

  it('pairs a click with the sample before it and the first one AFTER_CLICK_MS later', () => {
    const c = recordingCandidates(samples(10), [{ t: 1600, x: 5, y: 6 }])
    expect(c.filter(f => f.reason.endsWith('click'))).toEqual([
      { t: 1500, reason: 'before-click', score: 0, click: { x: 5, y: 6 }, sample: 2 },
      { t: 2250, reason: 'after-click', score: 0, click: { x: 5, y: 6 }, sample: 5 }
    ])
  })

  it('leaves out the half of a click that has no sample', () => {
    const c = recordingCandidates(samples(4), [{ t: 1700, x: 1, y: 1 }])
    expect(c.filter(f => f.reason.endsWith('click')).map(f => [f.reason, f.sample])).toEqual([
      ['before-click', 2]
    ])
  })

  it('drops the clicks made before the first sample: the helper starts before the stream', () => {
    const c = recordingCandidates(samples(10), [{ t: 900, x: 0, y: 0 }, { t: 1600, x: 5, y: 6 }])
    expect(c.filter(f => f.reason.endsWith('click')).map(f => [f.reason, f.sample, f.click])).toEqual([
      ['before-click', 2, { x: 5, y: 6 }],
      ['after-click', 5, { x: 5, y: 6 }]
    ])
  })

  it('does not count a sample twice as a change', () => {
    const c = recordingCandidates(samples(8, { 2: 0.3, 7: 0.2 }), [{ t: 1550, x: 1, y: 1 }])
    expect(c.filter(f => f.reason === 'change')).toEqual([])
  })
})

describe('isRepeatClick', () => {
  it('is true within AFTER_CLICK_MS and 8 points of the previous click', () => {
    expect(isRepeatClick({ t: 0, x: 10, y: 10 }, { t: 200, x: 14, y: 13 })).toBe(true)
    expect(isRepeatClick({ t: 0, x: 10, y: 10 }, { t: 500, x: 10, y: 18 })).toBe(true)
  })

  it('is false further in time or space', () => {
    expect(isRepeatClick({ t: 0, x: 10, y: 10 }, { t: 501, x: 10, y: 10 })).toBe(false)
    expect(isRepeatClick({ t: 0, x: 10, y: 10 }, { t: 300, x: 10, y: 19 })).toBe(false)
  })
})

describe('createFrameCollector', () => {
  // Global points map to image pixels ×2 inside a 0..100 region; outside it, no point.
  const toImage = (c: { x: number; y: number }) => (c.x >= 0 && c.x <= 100 && c.y >= 0 && c.y <= 100 ? { x: c.x * 2, y: c.y * 2 } : null)
  /** `n` samples every 250 ms from `from`, named by their time. */
  function feed(n: number, o: { changes?: Record<number, number>; from?: number; into?: ReturnType<typeof createFrameCollector<string>> } = {}) {
    const collector = o.into ?? createFrameCollector<string>(toImage)
    for (let i = 0; i < n; i++) {
      const t = (o.from ?? 1000) + i * 250
      collector.sample({ t, image: `S${t}`, ...(o.changes && i in o.changes ? { change: o.changes[i] } : {}) })
    }
    return collector
  }
  const pairs = (c: ReturnType<typeof createFrameCollector<string>>) =>
    c.candidates().candidates.filter(f => f.reason.endsWith('click')).map(f => [f.reason, f.image, f.click])

  it('keeps only the start, the changes and the last three samples', () => {
    const c = feed(40, { changes: { 10: 0.1, 20: 0.2 } })
    expect(c.held()).toBe(6)
    expect(c.candidates().candidates.map(f => [f.reason, f.image])).toEqual([
      ['start', 'S1000'], ['change', 'S3500'], ['change', 'S6000'], ['end', 'S10750']
    ])
  })

  it('keeps the frame before a click and the one AFTER_CLICK_MS later, live', () => {
    const c = feed(4)
    c.click({ t: 1800, x: 5, y: 6 })
    feed(30, { from: 2000, into: c })
    expect(pairs(c)).toEqual([
      ['before-click', 'S1750', { x: 10, y: 12 }],
      ['after-click', 'S2500', { x: 10, y: 12 }]
    ])
    expect(c.held()).toBe(6)
  })

  it('finds the before frame of a click that comes late, from the last samples', () => {
    const c = feed(10)
    c.click({ t: 2800, x: 5, y: 6 })
    expect(pairs(c)).toEqual([['before-click', 'S2750', { x: 10, y: 12 }]])
  })

  it('merges a double-click into one pair', () => {
    const c = feed(4)
    c.click({ t: 1800, x: 5, y: 6 })
    c.click({ t: 1950, x: 7, y: 6 })
    feed(10, { from: 2000, into: c })
    expect(pairs(c)).toHaveLength(2)
    expect(c.candidates().clickCount).toBe(1)
  })

  it('keeps two distant clicks 300 ms apart as two pairs', () => {
    const c = feed(4)
    c.click({ t: 1800, x: 5, y: 6 })
    c.click({ t: 2100, x: 60, y: 60 })
    feed(10, { from: 2000, into: c })
    expect(pairs(c).map(p => p[0])).toEqual(['before-click', 'before-click', 'after-click', 'after-click'])
    expect(c.candidates().clickCount).toBe(2)
  })

  it('ignores a click seen twice, out of the region, or before the first sample', () => {
    const c = feed(4)
    c.click({ t: 1800, x: 5, y: 6 })
    c.click({ t: 1800, x: 5, y: 6 })
    c.click({ t: 1900, x: 500, y: 6 })
    c.click({ t: 900, x: 50, y: 50 })
    expect(c.candidates().clickCount).toBe(1)
  })

  it('gives the span of the recording', () => {
    expect(feed(5).candidates()).toMatchObject({ t0: 1000, t1: 2000 })
  })
})
