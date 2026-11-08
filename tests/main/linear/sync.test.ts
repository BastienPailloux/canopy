import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LinearIssue, LinearStatusType } from '../../../src/shared/linear'
import { LinearExpiredError } from '../../../src/main/linear/client'
import { LinearError, LinearFormatError } from '../../../src/main/linear/parse'
import { LinearSync } from '../../../src/main/linear/sync'

const me = { id: 'u1', name: 'Bastien' }
const issue = (id: string, type: LinearStatusType = 'started', assignee: LinearIssue['assignee'] = me): LinearIssue => ({
  id, uuid: `uuid-${id}`, title: `Title ${id}`, description: '', url: `https://linear.app/${id}`,
  status: { id: null, name: type, type }, priority: 'none', labels: [], assignee,
  team: { id: 't', name: 'Eng' }, parentId: null, cycle: null, project: null, updatedAt: '2026-01-01T00:00:00Z',
})

function fake() {
  const f = {
    mine: [] as LinearIssue[],
    briefs: {} as Record<string, LinearIssue | Error>,
    listError: null as Error | null,
    briefCalls: [] as string[],
    listMine: async () => { if (f.listError) throw f.listError; return f.mine },
    issueBrief: async (id: string) => {
      f.briefCalls.push(id)
      const b = f.briefs[id]
      if (!b) throw new LinearError('not found', true)
      if (b instanceof Error) throw b
      return b
    },
    connection: () => ({ state: 'connected' as const }),
  }
  return f
}

let file: string
let dir: string
const clock = () => new Date('2026-02-02T10:00:00Z')
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'linsync-')); file = join(dir, 'linear-cache.json') })
const make = (f: ReturnType<typeof fake>, extra: string[] = []) => new LinearSync(file, f as never, () => extra, clock)

describe('LinearSync', () => {
  it('error keeps the last list', async () => {
    const f = fake(); f.mine = [issue('A-1'), issue('A-2'), issue('A-3')]
    const s = make(f)
    const ok = await s.refresh()
    f.listError = new Error('network down')
    const st = await s.refresh()
    expect(st.issues).toHaveLength(3)
    expect(st.error).toMatch(/network down/)
    expect(st.fetchedAt).toBe(ok.fetchedAt)
    expect(ok.fetchedAt).toBe('2026-02-02T10:00:00.000Z')
  })

  it('unreadable answer is an error, not an empty list', async () => {
    const f = fake(); f.mine = [issue('A-1'), issue('A-2'), issue('A-3')]
    const s = make(f)
    const ok = await s.refresh()
    f.listError = new LinearFormatError('list_issues', 'not json')
    const st = await s.refresh()
    expect(st.issues).toHaveLength(3)
    expect(st.error).not.toBeNull()
    expect(st.fetchedAt).toBe(ok.fetchedAt)
  })

  it('expired token keeps the cached list', async () => {
    const f = fake(); f.mine = [issue('A-1')]
    const s = make(f)
    await s.refresh()
    f.listError = new LinearExpiredError()
    const st = await s.refresh()
    expect(st.expired).toBe(true)
    expect(st.issues).toHaveLength(1)
  })

  it('cache survives a restart', async () => {
    const f = fake(); f.mine = [issue('A-1'), issue('A-2')]
    await make(f).refresh()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const s2 = make(fake())
    expect(s2.state().issues.map((i) => i.id)).toEqual(['A-1', 'A-2'])
    expect(s2.state().fetchedAt).toBe('2026-02-02T10:00:00.000Z')
  })

  it('corrupt cache starts empty and is set aside', () => {
    writeFileSync(file, '{nope')
    const s = make(fake())
    expect(s.state().issues).toEqual([])
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(true)
  })

  it('departure reasons', async () => {
    const f = fake()
    f.mine = [issue('R-1'), issue('C-1'), issue('M-1'), issue('D-1'), issue('N-1')]
    const s = make(f)
    await s.refresh()
    f.mine = []
    f.briefs['R-1'] = issue('R-1', 'started', { id: 'u2', name: 'Other' })
    f.briefs['C-1'] = issue('C-1', 'canceled')
    f.briefs['D-1'] = issue('D-1', 'completed')
    f.briefs['N-1'] = new Error('offline')
    const st = await s.refresh()
    const reasons = Object.fromEntries(st.departures.map((d) => [d.id, d.reason]))
    expect(reasons).toEqual({ 'R-1': 'reassigned', 'C-1': 'canceled', 'M-1': 'missing' })
    expect(st.issues.map((i) => i.id).sort()).toEqual(['D-1', 'N-1'])
    expect(st.error).toBeNull()
  })

  it('unassigned counts as reassigned and acked departures are dropped and persisted', async () => {
    const f = fake(); f.mine = [issue('R-1')]
    const s = make(f)
    await s.refresh()
    f.mine = []; f.briefs['R-1'] = issue('R-1', 'started', null)
    await s.refresh()
    expect(make(f).state().departures).toHaveLength(1)
    s.ackDepartures(['R-1'])
    expect(s.state().departures).toEqual([])
    expect(make(f).state().departures).toEqual([])
  })

  it('launched issue stays listed', async () => {
    const f = fake(); f.mine = [issue('ENG-1')]
    f.briefs['ENG-9'] = issue('ENG-9', 'started', null)
    const s = make(f, ['ENG-9'])
    const st = await s.refresh()
    expect(st.issues.map((i) => i.id).sort()).toEqual(['ENG-1', 'ENG-9'])
    expect(st.departures).toEqual([])
    f.mine = [issue('ENG-1')]
    expect((await s.refresh()).issues.map((i) => i.id)).toContain('ENG-9')
  })

  it('a launched issue reassigned while launched departs as reassigned once no longer launched', async () => {
    const f = fake() as ReturnType<typeof fake> & { connection: () => { state: 'connected'; userId?: string } }
    f.connection = () => ({ state: 'connected', userId: me.id })
    f.mine = [issue('ENG-1'), issue('ENG-2')]
    let launched = ['ENG-2']
    const s = new LinearSync(file, f as never, () => launched, clock)
    await s.refresh()
    const other = { id: 'u2', name: 'Alice' }
    f.mine = [issue('ENG-1')]
    f.briefs['ENG-2'] = issue('ENG-2', 'started', other)
    const kept = await s.refresh()
    expect(kept.issues.map((i) => i.id)).toContain('ENG-2')
    expect(kept.departures).toEqual([])
    launched = []
    const gone = await s.refresh()
    expect(gone.issues.map((i) => i.id)).toEqual(['ENG-1'])
    expect(gone.departures).toEqual([{ id: 'ENG-2', title: 'Title ENG-2', reason: 'reassigned' }])
  })

  it('a launched issue that becomes canceled or duplicate stays listed, kept, with no departure; it departs once unlaunched', async () => {
    const f = fake(); f.mine = [issue('ENG-1'), issue('ENG-2'), issue('ENG-3')]
    let launched = ['ENG-2', 'ENG-3']
    const s = new LinearSync(file, f as never, () => launched, clock)
    await s.refresh()
    f.mine = [issue('ENG-1'), { ...issue('ENG-2', 'canceled'), status: { id: null, name: 'Canceled', type: 'canceled' } }]
    f.briefs['ENG-3'] = { ...issue('ENG-3', 'duplicate'), status: { id: null, name: 'Duplicate', type: 'duplicate' } }
    const st = await s.refresh()
    expect(st.issues.map((i) => [i.id, i.status.name])).toEqual([['ENG-1', 'started'], ['ENG-2', 'Canceled'], ['ENG-3', 'Duplicate']])
    expect(st.kept.sort()).toEqual(['ENG-2', 'ENG-3'])
    expect(st.departures).toEqual([])
    launched = []
    const gone = await s.refresh()
    expect(gone.issues.map((i) => i.id)).toEqual(['ENG-1'])
    expect(gone.departures.map((d) => [d.id, d.reason])).toEqual([['ENG-2', 'canceled'], ['ENG-3', 'canceled']])
  })

  it('an issue with an unsent edit stays listed while it would leave; once the queue is empty it departs once, for its reason', async () => {
    const f = fake() as ReturnType<typeof fake> & { connection: () => { state: 'connected'; userId?: string } }
    f.connection = () => ({ state: 'connected', userId: me.id })
    f.mine = [issue('ENG-1'), issue('ENG-2'), issue('ENG-3')]
    let unsent = ['ENG-2', 'ENG-3']
    const s = new LinearSync(file, f as never, () => [], clock, () => unsent)
    await s.refresh()
    f.mine = [issue('ENG-1')]
    f.briefs['ENG-2'] = issue('ENG-2', 'started', { id: 'u2', name: 'Alice' }) // ENG-3: deleted in Linear
    const kept = await s.refresh()
    expect(kept.issues.map((i) => i.id)).toEqual(['ENG-1', 'ENG-2', 'ENG-3'])
    expect(kept.kept.sort()).toEqual(['ENG-2', 'ENG-3'])
    expect(kept.departures).toEqual([])
    unsent = []
    const gone = await s.refresh()
    expect(gone.issues.map((i) => i.id)).toEqual(['ENG-1'])
    expect(gone.departures.map((d) => [d.id, d.reason])).toEqual([['ENG-2', 'reassigned'], ['ENG-3', 'missing']])
    expect((await s.refresh()).departures).toHaveLength(2) // once: not added again
  })

  it('an unsent edit on an issue not in the cache yet is looked up and listed', async () => {
    const f = fake(); f.mine = [issue('ENG-1')]
    f.briefs['ENG-7'] = issue('ENG-7', 'canceled', null)
    const s = new LinearSync(file, f as never, () => [], clock, () => ['ENG-7'])
    expect((await s.refresh()).issues.map((i) => i.id)).toEqual(['ENG-1', 'ENG-7'])
  })

  it('own id comes from whoami, never from a listMine answer', async () => {
    const f = fake() as ReturnType<typeof fake> & { connection: () => { state: 'connected'; userId?: string } }
    f.connection = () => ({ state: 'connected', userId: 'u1' })
    f.mine = [issue('ENG-1', 'started', { id: 'u2', name: 'Alice' }), issue('ENG-2')]
    const s = make(f)
    await s.refresh()
    expect(JSON.parse(readFileSync(file, 'utf8')).me).toBe('u1')
    f.connection = () => ({ state: 'connected' })
    await make(f).refresh()
    expect(JSON.parse(readFileSync(file, 'utf8')).me).toBe('u1')
  })

  it('canceled issues are not listed', async () => {
    const f = fake(); f.mine = [issue('A-1'), issue('A-2', 'canceled'), issue('A-3', 'duplicate')]
    const st = await make(f).refresh()
    expect(st.issues.map((i) => i.id)).toEqual(['A-1'])
    expect(st.departures).toEqual([])
  })

  it('one refresh at a time', async () => {
    const f = fake(); f.mine = [issue('A-1')]
    const s = make(f)
    expect(s.refresh()).toBe(s.refresh())
    await s.refresh()
    expect(JSON.parse(readFileSync(file, 'utf8')).issues).toHaveLength(1)
  })

  it('clear wipes memory and disk', async () => {
    const f = fake(); f.mine = [issue('A-1')]
    const s = make(f)
    await s.refresh()
    let n = 0
    s.onChange(() => n++)
    s.clear()
    expect(s.state()).toEqual({ issues: [], fetchedAt: null, error: null, expired: false, departures: [], kept: [] })
    expect(existsSync(file)).toBe(false)
    expect(n).toBe(1)
  })

  it('refresh in flight during clear does not resurrect the list', async () => {
    const f = fake(); f.mine = [issue('A-1')]
    const s = make(f)
    const p = s.refresh()
    s.clear()
    await p
    expect(s.state().issues).toEqual([])
    expect(s.state().fetchedAt).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('a refresh after clear starts fresh', async () => {
    const f = fake()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    f.listMine = async () => {
      calls++
      if (calls === 1) { await gate; return [issue('OLD-1')] }
      return [issue('NEW-1')]
    }
    const s = make(f)
    const old = s.refresh()
    s.clear()
    const st = await s.refresh()
    expect(calls).toBe(2)
    expect(st.issues.map((i) => i.id)).toEqual(['NEW-1'])
    release()
    await old
    expect(s.state().issues.map((i) => i.id)).toEqual(['NEW-1'])
    expect(JSON.parse(readFileSync(file, 'utf8')).issues.map((i: LinearIssue) => i.id)).toEqual(['NEW-1'])
  })
})

describe('LinearSync call volume', () => {
  it('looks up the issues that left the list five at a time, each once', async () => {
    const f = fake()
    const ids = Array.from({ length: 12 }, (_, n) => `G-${n + 1}`)
    f.mine = ids.map((id) => issue(id))
    const s = make(f)
    await s.refresh()
    f.mine = []
    for (const id of ids) f.briefs[id] = issue(id, 'started', { id: 'u2', name: 'Other' })
    let running = 0
    let peak = 0
    const brief = f.issueBrief
    f.issueBrief = async (id: string) => {
      running++; peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      try { return await brief(id) } finally { running-- }
    }
    const st = await s.refresh()
    expect(peak).toBe(5)
    expect([...f.briefCalls].sort()).toEqual([...ids].sort())
    expect(st.departures).toHaveLength(12)
  })

  it('a launched issue deleted in Linear departs once as missing, keeps its link, and is not looked up again', async () => {
    const f = fake(); f.mine = []
    f.briefs['L-1'] = issue('L-1', 'started', { id: 'u2', name: 'Other' })
    const s = make(f, ['L-1'])
    expect((await s.refresh()).issues.map((i) => i.id)).toEqual(['L-1'])
    delete f.briefs['L-1']
    const st = await s.refresh()
    expect(st.departures).toEqual([{ id: 'L-1', title: 'Title L-1', reason: 'missing' }])
    f.briefCalls.length = 0
    s.ackDepartures(['L-1'])
    await s.refresh()
    await s.refresh()
    expect(f.briefCalls).toEqual([])
    expect(s.state().departures).toEqual([])
    expect(s.state().issues).toEqual([])
  })

  it('the not-found set survives a restart, and a launched issue never listed departs once under its ID', async () => {
    const f = fake(); f.mine = []
    const st = await make(f, ['L-2']).refresh()
    expect(st.departures).toEqual([{ id: 'L-2', title: 'L-2', reason: 'missing' }])
    f.briefCalls.length = 0
    await make(f, ['L-2']).refresh()
    expect(f.briefCalls).toEqual([])
  })

  it('a not-found launched issue that comes back in the list is listed again, and looked up again once it leaves', async () => {
    const f = fake(); f.mine = []
    const s = make(f, ['L-5'])
    await s.refresh()
    f.mine = [issue('L-5')]
    expect((await s.refresh()).issues.map((i) => i.id)).toEqual(['L-5'])
    f.mine = []
    f.briefs['L-5'] = issue('L-5', 'started', { id: 'u2', name: 'Other' })
    f.briefCalls.length = 0
    expect((await s.refresh()).issues.map((i) => i.id)).toEqual(['L-5'])
    expect(f.briefCalls).toEqual(['L-5'])
  })

  it('reconnecting (or another account) asks again for the issues not found', async () => {
    const f = fake() as ReturnType<typeof fake> & { connection: () => { state: 'connected'; userId?: string } }
    f.connection = () => ({ state: 'connected', userId: 'u1' })
    f.mine = []
    const s = make(f, ['L-6'])
    await s.refresh()
    f.briefs['L-6'] = issue('L-6')
    s.reconnected()
    expect((await s.refresh()).issues.map((i) => i.id)).toEqual(['L-6'])
    delete f.briefs['L-6']
    await s.refresh()
    f.briefs['L-6'] = issue('L-6')
    f.connection = () => ({ state: 'connected', userId: 'u9' })
    f.briefCalls.length = 0
    expect((await s.refresh()).issues.map((i) => i.id)).toEqual(['L-6'])
    expect(f.briefCalls).toEqual(['L-6'])
  })

  it('a missing launched issue with an unsent edit is neither set aside nor reported: it waits for Bastien', async () => {
    const f = fake(); f.mine = []
    f.briefs['L-3'] = issue('L-3')
    const s = new LinearSync(file, f as never, () => ['L-3'], clock, () => ['L-3'])
    await s.refresh()
    delete f.briefs['L-3']
    const st = await s.refresh()
    expect(st.issues.map((i) => i.id)).toEqual(['L-3'])
    expect(st.departures).toEqual([])
    f.briefCalls.length = 0
    await s.refresh()
    expect(f.briefCalls).toEqual(['L-3'])
  })

  it('a lookup that fails sets nothing aside', async () => {
    const f = fake(); f.mine = []
    f.briefs['L-4'] = new Error('network down')
    const s = make(f, ['L-4'])
    await s.refresh()
    f.briefCalls.length = 0
    await s.refresh()
    expect(f.briefCalls).toEqual(['L-4'])
  })
})

describe('LinearSync change events', () => {
  it('a refresh names the issues it changed, added, removed or reported; a clear names none (everything)', async () => {
    const f = fake(); f.mine = [issue('E-1'), issue('E-2')]
    const s = make(f)
    const seen: (string[] | undefined)[] = []
    s.onChange((ids) => { seen.push(ids) })
    await s.refresh()
    expect(seen.pop()?.sort()).toEqual(['E-1', 'E-2'])
    await s.refresh()
    expect(seen.pop()).toEqual([])
    f.mine = [{ ...issue('E-1'), title: 'Renamed', updatedAt: '2026-02-01T00:00:00Z' }, issue('E-3')]
    f.briefs['E-2'] = issue('E-2', 'started', { id: 'u2', name: 'Other' })
    await s.refresh()
    expect(seen.pop()?.sort()).toEqual(['E-1', 'E-2', 'E-3'])
    s.ackDepartures(['E-2'])
    expect(seen.pop()).toEqual(['E-2'])
    s.clear()
    expect(seen.pop()).toBeUndefined()
    expect(seen).toEqual([])
  })
})
