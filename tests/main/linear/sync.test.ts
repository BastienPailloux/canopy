import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
})
