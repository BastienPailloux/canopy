import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linearLaunchPrompt, type LinearIssue, type LinearLaunchRequest } from '../../src/shared/linear'
import { launchMockupsSection } from '../../src/shared/mockups'
import { launchPrompt, type LaunchRequest, type Ticket } from '../../src/shared/tickets'
import type { Worktree } from '../../src/shared/types'
import { depsLaunchPrompt, type DepEntry } from '../../src/shared/deps'

const calls: string[] = []
vi.mock('../../src/renderer/sessions/sessionStore', () => ({
  askClaude: vi.fn((cwd: string, text: string, o?: { expectLinear?: boolean }) => { calls.push(`askClaude ${cwd} ${text}${o?.expectLinear ? ' expectLinear' : ''}`); return 'tab' })
}))

const reloadLinearLinks = vi.fn(async () => {})
vi.mock('../../src/renderer/tickets/linearStore', () => ({ reloadLinearLinks }))

const { defaultBranchName, launchText, runDepsLaunch, runLaunch, runLinearLaunch } = await import('../../src/renderer/tickets/launchFlow')
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

  it('joins the linked mockups to the prompt, and only them', async () => {
    const mockups = [{ title: 'Scanner', url: 'https://claude.ai/artifact/WcXTxNhxSWaDL28ttqjZye' }]
    await runLaunch('/r', REQ, { startClaude: true, mockups })
    const expected = `${launchPrompt(ticket('x'))}\n\n${launchMockupsSection(mockups)}`
    expect(calls).toContain(`askClaude ${NEW.path} ${expected}`)
    expect(expected).toContain('- "Scanner" — https://claude.ai/artifact/WcXTxNhxSWaDL28ttqjZye')
  })

  it('an empty list of mockups leaves the prompt as it was', async () => {
    await runLaunch('/r', REQ, { startClaude: true, mockups: [] })
    expect(calls).toContain(`askClaude ${NEW.path} ${launchPrompt(ticket('x'))}`)
  })
})

describe('launchText', () => {
  it('is the ticket prompt alone without mockups', () => {
    expect(launchText(ticket('T'))).toBe(launchPrompt(ticket('T')))
    expect(launchText(ticket('T'), [])).toBe(launchPrompt(ticket('T')))
  })
  it('asks to read each mockup with the Artifact tool', () => {
    const text = launchText(ticket('T'), [{ title: 'A', url: 'u1' }, { title: 'B', url: 'u2' }])
    expect(text.startsWith(`${launchPrompt(ticket('T'))}\n\n`)).toBe(true)
    expect(text).toContain('Artifact')
    expect(text).toContain('- "A" — u1\n- "B" — u2')
  })
})

describe('runLinearLaunch', () => {
  const issue = { id: 'ENG-482', title: 'Export CSV', description: 'Détails', url: 'https://linear.app/x/issue/ENG-482' } as LinearIssue
  const LREQ: LinearLaunchRequest = { id: 'ENG-482', branch: 'feat/eng-482-export-csv', target: { kind: 'new', base: 'main' } }
  let linearLaunch: ReturnType<typeof vi.fn>
  const patchTicket = vi.fn()
  beforeEach(() => {
    calls.length = 0
    useApp.setState({ repo: '/r', worktree: '/r', worktrees: [MAIN], orphans: [], workspace: null, view: 'tickets' })
    linearLaunch = vi.fn(async () => ({ worktree: NEW.path, issue }))
    vi.stubGlobal('window', {
      canopy: {
        linearLaunch, patchTicket,
        listWorktrees: vi.fn(async () => [MAIN, NEW]),
        scanWorkspace: vi.fn(async () => { throw new Error('not used') })
      }
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends linearLaunchPrompt with expectLinear and never calls patchTicket', async () => {
    await runLinearLaunch('/r', LREQ, { startClaude: true })
    expect(linearLaunch).toHaveBeenCalledWith('/r', LREQ)
    expect(calls.filter((c) => c.startsWith('askClaude'))).toEqual([`askClaude ${NEW.path} ${linearLaunchPrompt(issue)} expectLinear`])
    expect(patchTicket).not.toHaveBeenCalled()
    expect(useApp.getState().view).toBe('sessions')
    expect(useApp.getState().worktree).toBe(NEW.path)
  })

  it('reads the links again: the list shows the new branch', async () => {
    reloadLinearLinks.mockClear()
    await runLinearLaunch('/r', LREQ, { startClaude: false })
    expect(reloadLinearLinks).toHaveBeenCalledTimes(1)
  })

  it('does not ask Claude when not asked to', async () => {
    await runLinearLaunch('/r', LREQ, { startClaude: false })
    expect(calls.some((c) => c.startsWith('askClaude'))).toBe(false)
  })
})

describe('runDepsLaunch', () => {
  const tar: DepEntry = {
    key: 'npm:package-lock.json:tar', ecosystem: 'npm', name: 'tar', manifest: 'package-lock.json', installed: '6.1.11', target: '6.2.1',
    level: 'critical', cause: 'advisory', reason: 'Faille critique', registryUrl: null,
    advisories: [{ id: 'GHSA-aaaa-bbbb-cccc', package: 'tar', severity: 'critical', summary: '', fixed: '6.2.1', url: 'https://osv.dev/x' }]
  }
  let depsLaunch: ReturnType<typeof vi.fn>
  beforeEach(() => {
    calls.length = 0
    useApp.setState({ repo: '/r', worktree: '/r', worktrees: [MAIN], orphans: [], workspace: null, view: 'deps' })
    depsLaunch = vi.fn(async () => { calls.push('depsLaunch'); return { worktree: NEW.path } })
    vi.stubGlobal('window', { canopy: { depsLaunch, listWorktrees: vi.fn(async () => [MAIN, NEW]) } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('launches, shows Sessions on the worktree, then asks Claude with the deps prompt', async () => {
    const req = { branch: 'fix/deps-2026-11-09', target: { kind: 'new', base: 'main' } as const }
    await runDepsLaunch('/r', req, [tar], { startClaude: true })
    expect(depsLaunch).toHaveBeenCalledWith('/r', req)
    // Earlier suites wrap setView to log it: only the order of launch and prompt matters here.
    const own = calls.filter((c) => !c.startsWith('setView'))
    expect(own).toEqual(['depsLaunch', `askClaude ${NEW.path} ${depsLaunchPrompt([tar])}`])
    expect(useApp.getState()).toMatchObject({ worktree: NEW.path, view: 'sessions' })
  })

  it('does not ask Claude when not asked to', async () => {
    await runDepsLaunch('/r', { branch: 'chore/x', target: { kind: 'new', base: 'main' } }, [tar], { startClaude: false })
    expect(calls.filter((c) => !c.startsWith('setView'))).toEqual(['depsLaunch'])
  })
})
