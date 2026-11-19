import { describe, expect, it } from 'vitest'
import { fingerprintDiff, selectKeyFrames, type Candidate } from '../../../src/renderer/capture/keyframes'

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
