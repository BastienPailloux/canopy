import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TicketListEntry } from '../../src/shared/tickets'
import { connectAfterMerge, useMerge } from '../../src/renderer/pr/MergePanel'
import { useApp } from '../../src/renderer/store'
import { useLinear } from '../../src/renderer/tickets/linearStore'
import { useTickets } from '../../src/renderer/tickets/ticketStore'

const OID = 'a'.repeat(40)
const ticket = (repo: string): TicketListEntry => ({ kind: 'ticket', ticket: { id: 'T-1', title: 'x', status: 'review', branch: 'feat/x', repo } } as unknown as TicketListEntry)

describe('pr:autoMerged', () => {
  let canopy: Record<string, ReturnType<typeof vi.fn>>
  let emit: (payload: unknown) => void
  let stop: () => void

  beforeEach(() => {
    canopy = {
      on: vi.fn((_e: string, fn: (p: unknown) => void) => { emit = fn; return () => undefined }),
      listTickets: vi.fn(async () => [ticket('/other')]),
      patchTicket: vi.fn(async () => ({})),
      prCleanup: vi.fn(async () => ({ kind: 'switched', branch: 'feat/y', steps: [] })),
      prDeleteLocalBranch: vi.fn(),
      prWatchAutoMerge: vi.fn(async () => undefined),
      listWorktrees: vi.fn(async () => []),
      scanWorkspace: vi.fn(async () => null)
    }
    vi.stubGlobal('window', { canopy })
    useMerge.setState({ results: {}, notice: null, removal: null })
    useLinear.setState({ links: {} })
    // The window shows another folder than the PR's.
    useApp.setState({ repo: '/open', workspace: null, worktrees: [] })
    useTickets.setState({ repo: '/open', entries: [ticket('/open')] })
    stop = connectAfterMerge()
  })
  afterEach(() => { stop(); vi.unstubAllGlobals() })

  const payload = (cleanup = true): unknown => ({ cwd: '/other/.worktrees/x', repo: '/other', req: { number: 87, branch: 'feat/x', headOid: OID }, cleanup })

  it('moves the ticket of the repo main named, cleans up, then stops the watch', async () => {
    emit(payload())
    await vi.waitFor(() => expect(canopy.prWatchAutoMerge).toHaveBeenCalledWith('/other/.worktrees/x', null))
    expect(canopy.listTickets).toHaveBeenCalledWith('/other')
    expect(canopy.patchTicket).toHaveBeenCalledWith('/other', 'T-1', { status: 'done' })
    expect(canopy.prCleanup).toHaveBeenCalledWith('/other/.worktrees/x', { number: 87, branch: 'feat/x', headOid: OID })
    // the ack comes after the work, never before
    expect(canopy.prWatchAutoMerge.mock.invocationCallOrder[0]).toBeGreaterThan(canopy.prCleanup.mock.invocationCallOrder[0])
  })

  it('an event sent again runs nothing twice, and is acknowledged again', async () => {
    emit(payload())
    await vi.waitFor(() => expect(canopy.prWatchAutoMerge).toHaveBeenCalledTimes(1))
    emit(payload())
    await vi.waitFor(() => expect(canopy.prWatchAutoMerge).toHaveBeenCalledTimes(2))
    expect(canopy.patchTicket).toHaveBeenCalledTimes(1)
    expect(canopy.prCleanup).toHaveBeenCalledTimes(1)
  })

  it('an unchecked box moves the ticket but cleans nothing', async () => {
    emit(payload(false))
    await vi.waitFor(() => expect(canopy.prWatchAutoMerge).toHaveBeenCalled())
    expect(canopy.patchTicket).toHaveBeenCalled()
    expect(canopy.prCleanup).not.toHaveBeenCalled()
  })

  it('a run that throws ends the run with a line, is acknowledged and not retried', async () => {
    // runAfterMerge swallows its own step errors: make the run itself throw.
    vi.spyOn(useLinear, 'getState').mockImplementationOnce(() => { throw new Error('boom') })
    emit(payload())
    await vi.waitFor(() => expect(canopy.prWatchAutoMerge).toHaveBeenCalledWith('/other/.worktrees/x', null))
    expect(useMerge.getState().results['/other/.worktrees/x#87'].lines).toEqual(['Fin du merge interrompue : boom'])
    emit(payload())
    await vi.waitFor(() => expect(canopy.prWatchAutoMerge).toHaveBeenCalledTimes(2))
    expect(canopy.prCleanup).not.toHaveBeenCalled()
  })

  it('ignores a payload without a repo', async () => {
    emit({ cwd: '/w', req: { number: 87, branch: 'feat/x', headOid: OID }, cleanup: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(canopy.prCleanup).not.toHaveBeenCalled()
  })
})
