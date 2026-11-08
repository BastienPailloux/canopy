import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunningCounts } from '../../../src/main/quit'
import { createUpdater, type UpdaterDeps } from '../../../src/main/update/updater'
import { FORCE_AFTER_MS } from '../../../src/main/update/schedule'
import type { Stash } from '../../../src/shared/update'

let dir: string
let file: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  dir = await mkdtemp(join(tmpdir(), 'canopy-updater-'))
  file = join(dir, 'update-stash.json')
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

const stash: Stash = {
  format: 1,
  buffers: [{ cwd: '/r', path: 'a.ts', text: 'x', version: 'v1' }],
  tabs: []
}

function setup(counts: Partial<RunningCounts> = {}) {
  const log: string[] = []
  const fake = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(() => { log.push('quitAndInstall') })
  })
  const broadcast = vi.fn((e: string) => { log.push(e) })
  const confirm = vi.fn(() => Promise.resolve(false))
  const finish = vi.fn((then: () => void) => { log.push('finish'); then() })
  const relaunch = vi.fn(() => { log.push('relaunch') })
  const deps: UpdaterDeps = {
    updater: fake as unknown as UpdaterDeps['updater'],
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    broadcast,
    counts: () => ({ sessions: 0, terminals: 0, buffers: 0, drafts: 0, tickets: 0, linear: 0, ...counts }),
    confirm,
    finish,
    relaunch,
    stashFile: file,
    stashTimeoutMs: 5000
  }
  const u = createUpdater(deps)
  u.start()
  return { u, fake, broadcast, confirm, finish, relaunch, log }
}

describe('updater', () => {
  it('downloaded update is broadcast as ready', () => {
    const { u, fake, broadcast } = setup()
    expect(fake.autoDownload).toBe(true)
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    fake.emit('update-downloaded', { version: '1.2.0' })
    const ready = { phase: 'ready', version: '1.2.0', deadline: 1_000_000 + FORCE_AFTER_MS }
    expect(u.state()).toEqual(ready)
    expect(broadcast).toHaveBeenCalledWith('update:state', ready)
    vi.advanceTimersByTime(4 * 3600_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('forced restart collects the stash then installs without confirm', async () => {
    const { u, fake, confirm, finish, log } = setup({ sessions: 2 })
    fake.emit('update-downloaded', { version: '1.2.0' })
    await vi.advanceTimersByTimeAsync(FORCE_AFTER_MS)
    expect(log).toContain('update:collectStash')
    expect(finish).not.toHaveBeenCalled()
    log.push('receiveStash')
    u.receiveStash(stash)
    await vi.advanceTimersByTimeAsync(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(stash)
    expect(log.slice(log.indexOf('update:collectStash'))).toEqual(['update:collectStash', 'receiveStash', 'finish', 'quitAndInstall'])
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('stash timeout', async () => {
    const { u, fake } = setup()
    fake.emit('update-downloaded', { version: '1.2.0' })
    void u.restart(false)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(existsSync(file)).toBe(false)
  })

  it('user restart with running sessions asks, cancel changes nothing', async () => {
    const { u, fake, broadcast, confirm, finish } = setup({ sessions: 1, terminals: 1 })
    fake.emit('update-downloaded', { version: '1.2.0' })
    broadcast.mockClear()
    await u.restart(true)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Redémarrer arrêtera'))
    expect(broadcast).not.toHaveBeenCalledWith('update:collectStash')
    expect(finish).not.toHaveBeenCalled()
    expect(u.state()).toMatchObject({ phase: 'ready' })
  })

  it('second restart while one runs is ignored', async () => {
    const { u, fake, broadcast, finish } = setup()
    fake.emit('update-downloaded', { version: '1.2.0' })
    void u.restart(true)
    void u.restart(true)
    void u.restart(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(broadcast.mock.calls.filter(([e]) => e === 'update:collectStash')).toHaveLength(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('a forced restart while the question is open finishes once, whatever the answer', async () => {
    const { u, fake, confirm, finish } = setup({ sessions: 1 })
    let answer: (v: boolean) => void = () => {}
    confirm.mockImplementation(() => new Promise<boolean>((r) => { answer = r }))
    fake.emit('update-downloaded', { version: '1.2.0' })
    void u.restart(true)
    await vi.advanceTimersByTimeAsync(FORCE_AFTER_MS)
    await vi.advanceTimersByTimeAsync(5000)
    expect(finish).toHaveBeenCalledTimes(1)
    answer(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('quitAndInstall that throws falls back to a relaunch', async () => {
    const { u, fake, relaunch } = setup()
    fake.quitAndInstall.mockImplementation(() => { throw new Error('no installer') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.emit('update-downloaded', { version: '1.2.0' })
    void u.restart(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(relaunch).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('an app still running 30 s after quitAndInstall relaunches', async () => {
    const { u, fake, relaunch } = setup()
    fake.emit('update-downloaded', { version: '1.2.0' })
    void u.restart(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(relaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})
