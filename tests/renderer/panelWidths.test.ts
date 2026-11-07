import { describe, expect, it } from 'vitest'
import { dragLeft, dragRight, parseLayout, railInitials, stepLeft } from '../../src/renderer/shell/panelWidths'

describe('dragLeft', () => {
  it('follows the pointer between the narrowest and widest full list', () => {
    expect(dragLeft(320)).toEqual({ width: 320, rail: false })
    expect(dragLeft(900)).toEqual({ width: 480, rail: false })
  })

  it('stops at the narrowest full list just above the rail threshold', () => {
    expect(dragLeft(150)).toEqual({ width: 200, rail: false })
  })

  it('becomes the rail once dragged too narrow, keeping the last full width', () => {
    expect(dragLeft(139, 320)).toEqual({ width: 320, rail: true })
    expect(dragLeft(0, 256)).toEqual({ width: 256, rail: true })
  })

  it('dragging the rail out past the threshold opens the full list again', () => {
    expect(dragLeft(140, 320)).toEqual({ width: 200, rail: false })
  })
})

describe('stepLeft', () => {
  it('moves the full list by the step', () => {
    expect(stepLeft({ left: 256, rail: false }, 16)).toEqual({ width: 272, rail: false })
    expect(stepLeft({ left: 480, rail: false }, 16)).toEqual({ width: 480, rail: false })
  })

  it('turns the narrowest list into the rail, keeping its width for later', () => {
    expect(stepLeft({ left: 210, rail: false }, -16)).toEqual({ width: 210, rail: true })
  })

  it('opens the rail again on a step outward only', () => {
    expect(stepLeft({ left: 320, rail: true }, 16)).toEqual({ width: 320, rail: false })
    expect(stepLeft({ left: 320, rail: true }, -16)).toEqual({ width: 320, rail: true })
  })
})

describe('dragRight', () => {
  it('grows as the pointer moves left, up to half the window', () => {
    expect(dragRight(300, 100, 1400)).toBe(400)
    expect(dragRight(300, 900, 1400)).toBe(700)
  })

  it('never goes below the narrowest panel', () => {
    expect(dragRight(300, -200, 1400)).toBe(240)
  })

  it('keeps the narrowest panel on a window too small for half of it', () => {
    expect(dragRight(300, 100, 400)).toBe(240)
  })
})

describe('parseLayout', () => {
  it('reads a saved layout', () => {
    expect(parseLayout('{"left":320,"rail":true,"right":420}')).toEqual({ left: 320, rail: true, right: 420 })
  })

  it('falls back to the defaults on nothing, garbage or a wrong shape', () => {
    const defaults = { left: 256, rail: false, right: 300 }
    expect(parseLayout(null)).toEqual(defaults)
    expect(parseLayout('{nope')).toEqual(defaults)
    expect(parseLayout('[1,2]')).toEqual(defaults)
    expect(parseLayout('{"left":"wide","rail":1,"right":null}')).toEqual(defaults)
  })

  it('brings a saved width out of range back inside it', () => {
    expect(parseLayout('{"left":20,"rail":false,"right":10}')).toEqual({ left: 200, rail: false, right: 240 })
    expect(parseLayout('{"left":9000,"rail":false,"right":300}')).toEqual({ left: 480, rail: false, right: 300 })
  })
})

describe('railInitials', () => {
  it('takes the first letters of the last two words of the branch', () => {
    expect(railInitials('feat/sidebar-collapse')).toBe('SC')
    expect(railInitials('feature-12')).toBe('F1')
  })

  it('takes two letters of a single word', () => {
    expect(railInitials('main')).toBe('MA')
    expect(railInitials('repo-a · fix/x')).toBe('X')
  })

  it('never returns nothing', () => {
    expect(railInitials('')).toBe('?')
    expect(railInitials('///')).toBe('?')
  })
})
