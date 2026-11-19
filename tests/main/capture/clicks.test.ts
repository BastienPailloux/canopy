import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CLICK_PERMISSION, clicksHelperPath, parseClickLine, startClickListener } from '../../../src/main/capture/clicks'

function fakeSpawn() {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() })
  const spawn = vi.fn(() => proc)
  return { proc, spawn: spawn as unknown as typeof import('node:child_process').spawn, mock: spawn }
}

describe('parseClickLine', () => {
  it('parses ready and click lines', () => {
    expect(parseClickLine('{"type":"ready","trusted":true}')).toEqual({ type: 'ready', trusted: true })
    expect(parseClickLine('{"type":"click","t":1,"x":2,"y":3}')).toEqual({ type: 'click', t: 1, x: 2, y: 3 })
  })

  it('rejects garbage, missing fields, non-numbers and unknown types', () => {
    for (const l of ['', 'nope', '{"type":"click","t":1,"x":2}', '{"type":"click","t":"1","x":2,"y":3}', '{"type":"ready"}', '{"type":"key","t":1,"x":2,"y":3}', 'null']) {
      expect(parseClickLine(l)).toBeNull()
    }
  })
})

describe('startClickListener', () => {
  it('spawns the helper with the permission check, without a shell', () => {
    const { spawn, mock } = fakeSpawn()
    startClickListener({ path: '/x/canopy-clicks', spawn })
    expect(mock).toHaveBeenCalledWith('/x/canopy-clicks', ['--check', CLICK_PERMISSION], expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'] }))
  })

  it('resolves ready, joins split lines and returns clicks in order on stop', async () => {
    const { proc, spawn } = fakeSpawn()
    const l = startClickListener({ path: 'h', spawn })
    proc.stdout.write('{"type":"ready","trus')
    proc.stdout.write('ted":true}\n{"type":"click","t":1,"x":2,"y":3}\n{"type":"click",')
    proc.stdout.write('"t":4,"x":5,"y":6}\n')
    await expect(l.ready).resolves.toEqual({ trusted: true })
    expect(l.stop()).toEqual([{ t: 1, x: 2, y: 3 }, { t: 4, x: 5, y: 6 }])
    expect(proc.stdin.end).toHaveBeenCalled()
  })

  it('survives a write error on stdin once the helper is gone (EPIPE)', () => {
    const { proc, spawn } = fakeSpawn()
    const l = startClickListener({ path: 'h', spawn })
    proc.emit('exit', 1)
    l.stop()
    // An unhandled error event would throw here, and crash main for real.
    expect(() => proc.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
  })

  it('resolves untrusted and returns no clicks when the process exits before ready', async () => {
    const { proc, spawn } = fakeSpawn()
    const l = startClickListener({ path: 'h', spawn })
    proc.emit('exit', 1)
    await expect(l.ready).resolves.toEqual({ trusted: false })
    expect(l.stop()).toEqual([])
  })

  it('resolves untrusted when spawn fails', async () => {
    const { proc, spawn } = fakeSpawn()
    const l = startClickListener({ path: 'h', spawn })
    proc.emit('error', new Error('ENOENT'))
    await expect(l.ready).resolves.toEqual({ trusted: false })
  })
})

describe('clicksHelperPath', () => {
  it('points into resources when packaged, into build/ otherwise', () => {
    expect(clicksHelperPath({ isPackaged: true, resourcesPath: '/r', appPath: '/a' })).toBe('/r/canopy-clicks')
    expect(clicksHelperPath({ isPackaged: false, resourcesPath: '/r', appPath: '/a' })).toBe('/a/build/capture/canopy-clicks')
  })
})
