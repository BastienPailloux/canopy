import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchTickets } from '../../../src/main/tickets/watch'

let root: string
let stop: (() => void) | undefined
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'canopy-twatch-')) })
afterEach(async () => {
  stop?.()
  stop = undefined
  await rm(root, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('watchTickets', () => {
  it('fires once for a burst of writes in .tickets', async () => {
    await mkdir(join(root, '.tickets'))
    let calls = 0
    stop = watchTickets(root, () => { calls++ })
    await sleep(500)
    for (let i = 0; i < 5; i++) await writeFile(join(root, '.tickets', `T-${i}.md`), 'x')
    await vi_waitFor(() => calls >= 1)
    await sleep(500)
    expect(calls).toBe(1)
  })

  it('fires when an existing ticket is edited in place or replaced by rename', async () => {
    await mkdir(join(root, '.tickets'))
    const file = join(root, '.tickets', 'T-1.md')
    await writeFile(file, 'v1')
    let calls = 0
    stop = watchTickets(root, () => { calls++ })
    await sleep(500)
    await writeFile(file, 'v2')
    await vi_waitFor(() => calls >= 1)
    await sleep(300)
    const before = calls
    // How the store writes: a temp file, then a rename over the ticket.
    await writeFile(`${file}.abc.tmp`, 'v3')
    await rename(`${file}.abc.tmp`, file)
    await vi_waitFor(() => calls > before)
  })

  it('fires when .tickets is created after watching started', async () => {
    let calls = 0
    stop = watchTickets(root, () => { calls++ })
    await sleep(500)
    await mkdir(join(root, '.tickets'))
    await writeFile(join(root, '.tickets', 'T-1.md'), 'x')
    await vi_waitFor(() => calls >= 1)
  })
})

async function vi_waitFor(cond: () => boolean): Promise<void> {
  const end = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await sleep(25)
  }
}
