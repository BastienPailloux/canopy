import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../../src/main/appStore'
import { createAutoMergeWatch } from '../../../src/main/github/autoMergeWatch'
import type { PrGateway } from '../../../src/main/github/gateway'
import type { PrDetail, PrState } from '../../../src/shared/pr'

let dir: string
let store: AppStore
let state: PrState
let events: [string, unknown][]
let tick: (() => void) | null
let period: number | null
let mergedOid: string

const gateway = (): PrGateway => ({
  find: async (_cwd, branch) => (branch === 'feat/x' ? { number: 87, state, title: 't', url: 'u' } : null),
  view: async (_cwd, n) => ({ number: n, state, head: 'feat/x', headOid: mergedOid } as PrDetail),
  options: async () => ({ labels: [], assignable: [], suggested: [] }),
  failedLog: async () => '',
  branchStates: async () => null,
  act: async () => ({ ok: true }),
})
const watch = () => createAutoMergeWatch({
  store, gateway: gateway(), broadcast: (e, p) => { events.push([e, p]) },
  setInterval: (fn, ms) => { tick = fn; period = ms; return 1 },
})
const req = { number: 87, branch: 'feat/x', headOid: 'a'.repeat(40) }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-automerge-'))
  store = new AppStore(join(dir, 'state.json'))
  state = 'open'
  events = []
  tick = null
  period = null
  mergedOid = 'a'.repeat(40)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('AutoMergeWatch', () => {
  it('broadcasts once when the watched PR is merged', async () => {
    const w = watch()
    w.start()
    expect(period).toBe(60_000)
    w.watch('/r/wt', { ...req, cleanup: true })
    await w.poll()
    expect(events).toEqual([])
    state = 'merged'
    tick!()
    await w.poll()
    await w.poll()
    expect(events).toEqual([['pr:autoMerged', { cwd: '/r/wt', req, cleanup: true }]])
    expect(store.autoMerges).toEqual({})
  })

  it('the broadcast carries the head GitHub merged, not the one known when enabled', async () => {
    const w = watch()
    w.watch('/r/wt', { ...req, cleanup: true })
    mergedOid = 'b'.repeat(40)
    state = 'merged'
    await w.poll()
    expect(events).toEqual([['pr:autoMerged', { cwd: '/r/wt', req: { ...req, headOid: mergedOid }, cleanup: true }]])
  })

  it('forgets a closed PR silently', async () => {
    const w = watch()
    w.watch('/r/wt', { ...req, cleanup: true })
    state = 'closed'
    await w.poll()
    expect(events).toEqual([])
    expect(store.autoMerges).toEqual({})
  })

  it('a box left unchecked broadcasts with cleanup false: the ticket still goes to Done', async () => {
    const w = watch()
    w.watch('/r/wt', { ...req, cleanup: false })
    state = 'merged'
    await w.poll()
    expect(events).toEqual([['pr:autoMerged', { cwd: '/r/wt', req, cleanup: false }]])
    expect(store.autoMerges).toEqual({})
  })

  it('survives a restart and stops with null', async () => {
    watch().watch('/r/wt', { ...req, cleanup: true })
    store = new AppStore(join(dir, 'state.json'))
    expect(store.autoMerges).toEqual({ '/r/wt': { ...req, cleanup: true } })
    const w = watch()
    w.watch('/r/wt', null)
    state = 'merged'
    await w.poll()
    expect(events).toEqual([])
    expect(store.autoMerges).toEqual({})
  })
})
