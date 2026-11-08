import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchPrompt, type LaunchRequest, type Ticket } from '../../src/shared/tickets'
import type { Worktree } from '../../src/shared/types'

const calls: string[] = []
vi.mock('../../src/renderer/sessions/sessionStore', () => ({
  askClaude: vi.fn((cwd: string, text: string) => { calls.push(`askClaude ${cwd} ${text}`); return 'tab' })
}))

const { defaultBranchName, runLaunch } = await import('../../src/renderer/tickets/launchFlow')
const { useApp } = await import('../../src/renderer/store')

const ticket = (title: string): Ticket => ({
  id: 'CAN-1', title, description: '', status: 'todo', priority: 'none', labels: [], subtasks: [], created: '', updated: '', archived: false
})
const REQ: LaunchRequest = { id: 'CAN-1', branch: 'feat/x', target: { kind: 'new', base: 'main' }, setInProgress: true }
const MAIN: Worktree = { path: '/r', branch: 'main', head: 'a', isMain: true }
const NEW: Worktree = { path: '/r/.worktrees/feat-x', branch: 'feat/x', head: 'b', isMain: false }

describe('defaultBranchName', () => {
  it('is feat/<slug> by default', () => {
    expect(defaultBranchName(ticket('Export JSON-LD du passeport textile'))).toBe('feat/export-json-ld-du-passeport')
  })
  it('takes the given type', () => {
    expect(defaultBranchName(ticket('Corriger l’import'), 'fix')).toBe('fix/corriger-l-import')
  })
})

describe('runLaunch', () => {
  let launchTicket: ReturnType<typeof vi.fn>
  beforeEach(() => {
    calls.length = 0
    useApp.setState({ repo: '/r', worktree: '/r', worktrees: [MAIN], orphans: [], workspace: null, view: 'tickets' })
    launchTicket = vi.fn(async () => { calls.push('launchTicket'); return { worktree: NEW.path, ticket: ticket('x') } })
    vi.stubGlobal('window', {
      canopy: {
        launchTicket,
        listWorktrees: vi.fn(async () => { calls.push('listWorktrees'); return [MAIN, NEW] }),
        scanWorkspace: vi.fn(async () => { throw new Error('not used without a workspace') })
      }
    })
    const setView = useApp.getState().setView
    useApp.setState({ setView: (v) => { calls.push(`setView ${v}`); setView(v) } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('launches, rescans, selects the worktree, shows Sessions, then asks Claude', async () => {
    await runLaunch('/r', REQ, { startClaude: true })
    expect(launchTicket).toHaveBeenCalledWith('/r', REQ)
    expect(calls).toEqual(['launchTicket', 'listWorktrees', 'setView sessions', `askClaude ${NEW.path} ${launchPrompt(ticket('x'))}`])
    expect(useApp.getState().worktree).toBe(NEW.path)
    expect(useApp.getState().worktrees.map((w) => w.path)).toEqual([MAIN.path, NEW.path])
    expect(useApp.getState().view).toBe('sessions')
  })

  it('does not ask Claude when not asked to', async () => {
    await runLaunch('/r', REQ, { startClaude: false })
    expect(calls.some((c) => c.startsWith('askClaude'))).toBe(false)
    expect(useApp.getState().view).toBe('sessions')
  })

  it('on failure leaves the view and rethrows', async () => {
    launchTicket.mockRejectedValueOnce(new Error('La branche "feat/x" existe déjà'))
    await expect(runLaunch('/r', REQ, { startClaude: true })).rejects.toThrow('existe déjà')
    expect(useApp.getState().view).toBe('tickets')
    expect(useApp.getState().worktree).toBe('/r')
    expect(calls).toEqual([])
  })

  it('builds the prompt from the ticket the launch returns', async () => {
    launchTicket.mockResolvedValueOnce({ worktree: NEW.path, ticket: ticket('Fresh from disk') })
    await runLaunch('/r', REQ, { startClaude: true })
    expect(calls).toContain(`askClaude ${NEW.path} ${launchPrompt(ticket('Fresh from disk'))}`)
  })

  it('does not navigate when the open repo changed meanwhile, but still starts Claude', async () => {
    launchTicket.mockImplementationOnce(async () => {
      useApp.setState({ repo: '/other' })
      return { worktree: NEW.path, ticket: ticket('x') }
    })
    await runLaunch('/r', REQ, { startClaude: true })
    expect(useApp.getState().view).toBe('tickets')
    expect(useApp.getState().worktree).toBe('/r')
    expect(calls.some((c) => c.startsWith('askClaude'))).toBe(true)
  })
})
