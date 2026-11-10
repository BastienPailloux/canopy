import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRegularFile } from '../../src/main/safeRead'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'safe-read-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('readRegularFile', () => {
  it('reads a regular file', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const r = await readRegularFile(join(dir, 'a.txt'), { maxBytes: 10 })
    expect(r.kind).toBe('file')
    expect(r.kind === 'file' && r.bytes.toString()).toBe('hello')
  })

  it('reads a file of exactly the limit, and one spanning several chunks, byte for byte', async () => {
    await writeFile(join(dir, 'edge.txt'), 'x'.repeat(10))
    expect(await readRegularFile(join(dir, 'edge.txt'), { maxBytes: 10 })).toEqual({ kind: 'file', bytes: Buffer.from('x'.repeat(10)) })
    const big = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251))
    await writeFile(join(dir, 'big.bin'), big)
    expect(await readRegularFile(join(dir, 'big.bin'), { maxBytes: 300_000 })).toEqual({ kind: 'file', bytes: big })
  })

  it('reports a file over the limit without returning its bytes', async () => {
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(11))
    expect(await readRegularFile(join(dir, 'big.txt'), { maxBytes: 10 })).toEqual({ kind: 'tooLarge', size: 11 })
  })

  it('reports a directory, a device or a FIFO as not a file, without blocking on the FIFO', async () => {
    await mkdir(join(dir, 'sub'))
    execFileSync('mkfifo', [join(dir, 'pipe')])
    expect(await readRegularFile(join(dir, 'sub'), { maxBytes: 10 })).toEqual({ kind: 'notFile' })
    expect(await readRegularFile('/dev/null', { maxBytes: 10 })).toEqual({ kind: 'notFile' })
    expect(await readRegularFile(join(dir, 'pipe'), { maxBytes: 10 })).toEqual({ kind: 'notFile' })
  })

  it('follows a symlink by default, refuses it with noFollow', async () => {
    await writeFile(join(dir, 'target'), 't')
    await symlink('target', join(dir, 'link'))
    expect((await readRegularFile(join(dir, 'link'), { maxBytes: 10 })).kind).toBe('file')
    await expect(readRegularFile(join(dir, 'link'), { maxBytes: 10, noFollow: true })).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('rejects a missing file with ENOENT', async () => {
    await expect(readRegularFile(join(dir, 'none'), { maxBytes: 10 })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
