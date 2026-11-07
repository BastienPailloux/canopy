import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { takeStash, writeStash } from '../../../src/main/update/stash'
import type { Stash } from '../../../src/shared/update'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-stash-'))
  file = join(dir, 'stash.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const stash: Stash = {
  format: 1,
  buffers: [{ cwd: '/r/one', path: 'src/a.ts', text: 'const a = 1\n', version: 'v1' }],
  tabs: [{
    cwd: '/r/one',
    sessionId: 's-1',
    title: 'Refactor',
    draft: { text: 'continue', images: [{ mediaType: 'image/png', base64: 'AAAA' }] },
    interrupted: true
  }]
}

describe('stash', () => {
  it('round trip', () => {
    writeStash(file, stash)
    expect(takeStash(file)).toEqual(stash)
    expect(existsSync(file)).toBe(false)
  })

  it('absent gives null', () => {
    expect(takeStash(file)).toBeNull()
  })

  it('corrupt stash', () => {
    writeFileSync(file, '{oops')
    expect(takeStash(file)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('unknown format', () => {
    writeFileSync(file, JSON.stringify({ ...stash, format: 2 }))
    expect(takeStash(file)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('an invalid entry rejects the whole stash', () => {
    const { version: _omitted, ...noVersion } = stash.buffers[0]
    writeFileSync(file, JSON.stringify({ ...stash, buffers: [noVersion] }))
    expect(takeStash(file)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('an image outside the allowed types rejects the whole stash', () => {
    const bad = { ...stash, tabs: [{ ...stash.tabs[0], draft: { text: '', images: [{ mediaType: 'image/svg+xml', base64: 'AAAA' }] } }] }
    writeFileSync(file, JSON.stringify(bad))
    expect(takeStash(file)).toBeNull()
  })

  it('leaves no temp file behind after a write', () => {
    writeStash(file, stash)
    expect(readdirSync(dir)).toEqual(['stash.json'])
  })
})

describe('stash format', () => {
  it('an empty stash round trips', () => {
    writeStash(file, { format: 1, buffers: [], tabs: [] })
    expect(takeStash(file)).toEqual({ format: 1, buffers: [], tabs: [] })
  })

  it('is readable by its owner only', () => {
    writeStash(file, stash)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
