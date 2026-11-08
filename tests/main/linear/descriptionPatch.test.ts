import { describe, expect, it } from 'vitest'
import { diffToPatch, rebase, type PatchOp } from '../../../src/main/linear/descriptionPatch'

const count = (s: string, sub: string): number => s.split(sub).length - 1
const anchorOf = (op: PatchOp): string => (op.op === 'replace' ? op.old_string : op.op === 'append' ? '' : op.anchor)

/** Linear's patch semantics: every anchor must match exactly once, ops in order. */
function apply(text: string, ops: PatchOp[]): string {
  let out = text
  for (const op of ops) {
    if (op.op === 'append') { out += op.text; continue }
    const anchor = anchorOf(op)
    expect(count(out, anchor)).toBe(1)
    const at = out.indexOf(anchor)
    if (op.op === 'replace') out = out.slice(0, at) + op.new_string + out.slice(at + anchor.length)
    else {
      const pos = op.op === 'insert_before' ? at : at + anchor.length
      out = out.slice(0, pos) + op.text + out.slice(pos)
    }
  }
  return out
}

const THREE = 'First paragraph talks about the login page.\n\nSecond paragraph lists the steps.\n\nThird paragraph is the conclusion.'

describe('diffToPatch', () => {
  it('equal texts give no op', () => {
    expect(diffToPatch(THREE, THREE)).toEqual([])
  })

  it('one word changed in a 3-paragraph text gives one replace unique in base', () => {
    const mine = THREE.replace('lists', 'describes')
    const ops = diffToPatch(THREE, mine)
    expect(ops).toHaveLength(1)
    const [op] = ops
    expect(op.op).toBe('replace')
    if (op.op !== 'replace') return
    expect(count(THREE, op.old_string)).toBe(1)
    expect(op.old_string.trim()).toBe('Second paragraph lists the steps.')
    expect(apply(THREE, ops)).toBe(mine)
  })

  it('appended paragraph gives insert_after anchored on the last line', () => {
    const mine = `${THREE}\n\nFourth paragraph, new.`
    const ops = diffToPatch(THREE, mine)
    expect(ops).toHaveLength(1)
    const [op] = ops
    expect(op).toMatchObject({ op: 'insert_after', text: '\n\nFourth paragraph, new.' })
    if (op.op !== 'insert_after') return
    expect(op.anchor.endsWith('Third paragraph is the conclusion.')).toBe(true)
    expect(op.anchor).not.toContain('Second')
    expect(apply(THREE, ops)).toBe(mine)
  })

  it('a changed line identical to another line elsewhere gets a widened unique anchor', () => {
    const base = 'Intro\n\n- [ ] todo\n\nMiddle\n\n- [ ] todo'
    const mine = 'Intro\n\n- [ ] todo\n\nMiddle\n\n- [x] todo'
    const ops = diffToPatch(base, mine)
    expect(ops).toHaveLength(1)
    const anchor = anchorOf(ops[0])
    expect(anchor).toContain('- [ ] todo')
    expect(count(base, anchor)).toBe(1)
    expect(apply(base, ops)).toBe(mine)
  })

  it('inserted paragraph in the middle and deleted paragraph apply exactly', () => {
    const inserted = 'A\n\nX\n\nB'
    expect(apply('A\n\nB', diffToPatch('A\n\nB', inserted))).toBe(inserted)
    expect(apply('A\n\nB\n\nC', diffToPatch('A\n\nB\n\nC', 'A\n\nC'))).toBe('A\n\nC')
    expect(apply('', diffToPatch('', 'new text'))).toBe('new text')
    expect(apply('old', diffToPatch('old', ''))).toBe('')
  })
})

describe('diffToPatch on random texts', () => {
  it('always gives one op, unique in base, that turns base into mine', () => {
    let seed = 42
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const text = () => Array.from({ length: rand(14) }, () => 'ab\n '[rand(4)]).join('')
    for (let i = 0; i < 3000; i++) {
      const base = text()
      const mine = text()
      const ops = diffToPatch(base, mine)
      if (base === mine) { expect(ops).toEqual([]); continue }
      expect(ops).toHaveLength(1)
      expect(apply(base, ops)).toBe(mine)
    }
  })
})

describe('rebase', () => {
  it('colleague edit elsewhere is kept', () => {
    const r = rebase('A\n\nB', 'A2\n\nB', 'A\n\nB2')
    expect(r.kind).toBe('clean')
    if (r.kind !== 'clean') return
    expect(apply('A\n\nB2', r.ops)).toBe('A2\n\nB2')
  })

  it('same passage is a conflict', () => {
    expect(rebase('A\n\nB', 'A2\n\nB', 'A3\n\nB')).toEqual({ kind: 'conflict', remote: 'A3\n\nB' })
  })

  it('unchanged remote is clean with the plain diff', () => {
    expect(rebase('A\n\nB', 'A2\n\nB', 'A\n\nB')).toEqual({ kind: 'clean', ops: diffToPatch('A\n\nB', 'A2\n\nB') })
  })

  it('remote already holding my text needs no op', () => {
    expect(rebase('A\n\nB', 'A2\n\nB', 'A2\n\nB')).toEqual({ kind: 'clean', ops: [] })
  })

  it('linear tags survive an unrelated edit', () => {
    const tag = '<linear-image>{"type":"image","attrs":{"src":"https://uploads.linear.app/x/y","title":"shot.png","width":1920}}</linear-image>'
    const base = `Context paragraph.\n\n${tag}\n\nSteps to reproduce.`
    const mine = base.replace('Steps to reproduce.', 'Steps to reproduce, updated.')
    const remote = base.replace('Context paragraph.', 'Context paragraph, edited by a colleague.')
    const r = rebase(base, mine, remote)
    expect(r.kind).toBe('clean')
    if (r.kind !== 'clean') return
    for (const op of r.ops) expect(anchorOf(op)).not.toContain('linear-image')
    const out = apply(remote, r.ops)
    expect(out).toContain(`\n\n${tag}\n\n`)
    expect(out).toBe(`Context paragraph, edited by a colleague.\n\n${tag}\n\nSteps to reproduce, updated.`)
  })
})
