import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TicketStore } from '../../../src/main/tickets/store'
import { watchFolder, watchTickets } from '../../../src/main/tickets/watch'
import { createRepo } from '../../helpers/repo'

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
  it('coalesces a burst of writes in .tickets', async () => {
    await mkdir(join(root, '.tickets'))
    let calls = 0
    stop = watchTickets(root, () => { calls++ })
    await sleep(500)
    // Spaced writes: without the debounce, each one would refresh. On a loaded CI runner one gap
    // between events can outlast the debounce, so a single refresh is not guaranteed: two are tolerated.
    for (let i = 0; i < 10; i++) {
      await writeFile(join(root, '.tickets', `T-${i}.md`), 'x')
      await sleep(20)
    }
    await vi_waitFor(() => calls >= 1)
    await sleep(500)
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('fires when a template is written', async () => {
    await mkdir(join(root, '.tickets', 'templates'), { recursive: true })
    let calls = 0
    stop = watchTickets(root, () => { calls++ })
    await sleep(500)
    await writeFile(join(root, '.tickets', 'templates', 'bug.md'), 'x')
    await vi_waitFor(() => calls >= 1)
    expect(calls).toBeGreaterThanOrEqual(1)
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

  it('fires when a ticket or template created by the store is deleted outside Canopy', async () => {
    // macOS FSEvents reports nothing for the deletion of a file created by hard link: the store must not create that way.
    const repo = await createRepo({ dirName: 'canopy' })
    try {
      const store = new TicketStore()
      await store.templates(repo.path)
      const ticket = await store.create(repo.path, { title: 'T', description: '', status: 'backlog', priority: 'none', labels: [], subtasks: [] })
      const template = await store.saveTemplate(repo.path, null, { name: 'Neuf', description: 'd', priority: 'none', labels: [], subtasks: [] })
      let calls = 0
      stop = watchTickets(repo.path, () => { calls++ })
      await sleep(500)
      for (const file of [join('.tickets', `${ticket.id}.md`), join('.tickets', 'templates', 'bug.md'), join('.tickets', 'templates', `${template.slug}.md`)]) {
        const before = calls
        await rm(join(repo.path, file))
        await vi_waitFor(() => calls > before)
        await sleep(300)
      }
    } finally {
      stop?.()
      stop = undefined
      await repo.cleanup()
    }
  })

  it('fires when .tickets is created after watching started', async () => {
    let calls = 0
    stop = watchTickets(root, () => { calls++ })
    await sleep(500)
    await mkdir(join(root, '.tickets'))
    await writeFile(join(root, '.tickets', 'T-1.md'), 'x')
    await vi_waitFor(() => calls >= 1)
  })

  it('watchFolder follows another folder only', async () => {
    let calls = 0
    stop = watchFolder(root, '.mockups', () => { calls++ })
    await sleep(500)
    await mkdir(join(root, '.tickets'))
    await writeFile(join(root, '.tickets', 'T-1.md'), 'x')
    await sleep(500)
    expect(calls).toBe(0)
    await mkdir(join(root, '.mockups'))
    await writeFile(join(root, '.mockups', 'mockups.json'), '{}')
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
