import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopyApi } from '../../src/shared/api'
import type { SessionSummary } from '../../src/shared/types'
import {
  answerPermission, askClaude, closeActiveTabIfSafe, closeTab, composerDraftCount, ensureTab, modeFrom, interrupt, openSession, setDraftDocuments, setDraftText, submit, syncWorktree, useSessions, warmUp, type SessionTab
} from '../../src/renderer/sessions/sessionStore'

const CWD = '/repo'
const PAST: SessionSummary = { sessionId: 'past', title: 'Ancienne', lastModified: 1, live: false, state: 'stopped' }
const HISTORY = [
  { type: 'user', uuid: 'a', session_id: 'past', parent_tool_use_id: null, message: { role: 'user', content: 'salut' } },
  { type: 'assistant', uuid: 'b', session_id: 'past', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'OK' }] } }
] as unknown as SessionMessage[]

type Method = 'repoTrust' | 'trustRepo' | 'startSession' | 'stopSession' | 'sendToSession' | 'interruptSession' | 'resolvePermission'
  | 'listSessions' | 'sessionHistory' | 'sessionCommands' | 'sessionModels'
let api: Record<Method, ReturnType<typeof vi.fn>>

const TRUSTED = { trusted: true, configHash: 'h', hooks: [], mcpServers: [], allowRules: [], apiKeyHelper: [], statusLine: [], env: [], settingsKeys: [], unknownFiles: [] }
const REQUEST = { requestId: 'r1', localId: 'local-1', toolName: 'Bash', input: {}, canAlways: false, toolUseID: 't' }

const tabs = (): SessionTab[] => Object.values(useSessions.getState().tabs)
const activeTab = (): SessionTab => useSessions.getState().tabs[useSessions.getState().active[CWD]]

beforeEach(() => {
  useSessions.setState({ tabs: {}, active: {}, permissions: [], summaries: {}, trustPrompt: null })
  api = {
    repoTrust: vi.fn(async () => TRUSTED),
    trustRepo: vi.fn(async () => undefined),
    startSession: vi.fn(async () => 'local-1'),
    stopSession: vi.fn(async () => undefined),
    sendToSession: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => undefined),
    resolvePermission: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    sessionHistory: vi.fn(async () => HISTORY),
    sessionCommands: vi.fn(async () => []),
    sessionModels: vi.fn(async () => [])
  }
  vi.stubGlobal('window', { canopy: api as unknown as CanopyApi })
})

describe('openSession', () => {
  it('shows the history and the warning, replaces the untouched draft tab and starts nothing', async () => {
    ensureTab(CWD)
    await openSession(CWD, PAST)

    expect(tabs()).toHaveLength(1)
    const tab = activeTab()
    expect(tab).toMatchObject({ sessionId: 'past', title: 'Ancienne', state: 'stopped' })
    expect(tab.transcript.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'notice'])
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('keeps a draft tab holding text', async () => {
    ensureTab(CWD)
    setDraftText(activeTab().id, 'en cours de frappe')
    await openSession(CWD, PAST)
    expect(tabs()).toHaveLength(2)
  })

  it('selects the tab already open on that session', async () => {
    await openSession(CWD, PAST)
    const { id } = activeTab()
    ensureTab(CWD)
    await openSession(CWD, PAST)
    expect(tabs()).toHaveLength(1)
    expect(activeTab().id).toBe(id)
  })

  it('resumes the session on the first message', async () => {
    await openSession(CWD, PAST)
    const { id } = activeTab()
    setDraftText(id, 'suite')
    await submit(id)

    expect(api.startSession).toHaveBeenCalledWith(CWD, expect.objectContaining({ content: { text: 'suite' }, resumeId: 'past' }))
    expect(activeTab().localId).toBe('local-1')
    expect(activeTab().transcript.items.at(-1)).toEqual({ kind: 'user', text: 'suite', images: [] })
  })
})

describe('a past session whose history cannot be read', () => {
  beforeEach(() => { api.sessionHistory.mockRejectedValue(new Error('fichier illisible')) })

  it('says so in the tab', async () => {
    await openSession(CWD, PAST)
    expect(activeTab().error).toContain('fichier illisible')
    expect(activeTab().transcript.items.map((i) => i.kind)).toEqual(['notice'])
  })

  it('still resumes, rather than silently starting a new session', async () => {
    await openSession(CWD, PAST)
    const { id } = activeTab()
    setDraftText(id, 'suite')
    await submit(id)
    expect(api.startSession).toHaveBeenCalledWith(CWD, expect.objectContaining({ resumeId: 'past' }))
  })
})

describe('warmUp', () => {
  it('never starts a past session just to list commands', async () => {
    await openSession(CWD, PAST)
    warmUp(activeTab().id)
    await vi.waitFor(() => expect(api.repoTrust).not.toHaveBeenCalled())
    expect(api.startSession).not.toHaveBeenCalled()
  })

  it('starts nothing if the tab was closed while trust was checked', async () => {
    ensureTab(CWD)
    const { id } = activeTab()
    warmUp(id)
    closeTab(id)
    await vi.waitFor(() => expect(api.repoTrust).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r))
    expect(api.startSession).not.toHaveBeenCalled()
  })
})

describe('closeTab', () => {
  it('stops the process of a start that finishes after the tab closed', async () => {
    let finish = (_id: string): void => undefined
    api.startSession.mockReturnValue(new Promise((r) => { finish = r }))
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'bonjour')
    const sending = submit(id)
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled())
    closeTab(id)
    finish('late')
    await sending
    expect(api.stopSession).toHaveBeenCalledWith('late')
  })
})

describe('syncWorktree', () => {
  it('reattaches a running session with its real mode, without starting anything', async () => {
    api.listSessions.mockResolvedValue([{ ...PAST, live: true, state: 'running', localId: 'running-1', mode: 'plan' }])
    await syncWorktree(CWD)
    expect(activeTab()).toMatchObject({ localId: 'running-1', sessionId: 'past', mode: 'plan', state: 'running' })
    expect(api.startSession).not.toHaveBeenCalled()
  })
})

describe('failures reach the user', () => {
  const live = async (): Promise<string> => {
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'bonjour')
    await submit(id)
    return id
  }

  it('reports a failed interruption', async () => {
    api.interruptSession.mockRejectedValue(new Error('canal fermé'))
    interrupt(await live())
    await vi.waitFor(() => expect(activeTab().error).toContain('canal fermé'))
  })

  it('keeps a permission card until its answer is accepted, and reports a refusal', async () => {
    await live()
    useSessions.setState({ permissions: [REQUEST] })
    api.resolvePermission.mockRejectedValueOnce(new Error('canal fermé'))
    await answerPermission('r1', { allow: true })
    expect(useSessions.getState().permissions).toEqual([REQUEST])
    expect(activeTab().error).toContain('canal fermé')

    await answerPermission('r1', { allow: true })
    expect(useSessions.getState().permissions).toEqual([])
  })
})

describe('submit', () => {
  it('gives the message back when the start fails', async () => {
    api.startSession.mockRejectedValue(new Error('REPO_NOT_TRUSTED'))
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'bonjour')
    await submit(id)

    expect(activeTab()).toMatchObject({ state: 'error', error: "Ce dépôt n'est pas approuvé : la session n'a pas démarré." })
    expect(activeTab().draft.text).toBe('bonjour')
  })

  it('leaves no bubble behind a failed start, so a retry shows the message once', async () => {
    api.startSession.mockRejectedValueOnce(new Error('spawn ENOENT'))
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'bonjour')
    await submit(id)
    expect(activeTab().transcript.items).toEqual([])

    await submit(id)
    expect(activeTab().transcript.items).toEqual([{ kind: 'user', text: 'bonjour', images: [] }])
    expect(activeTab().error).toBeUndefined()
  })

  it('asks again when the config changed between the check and the start', async () => {
    api.startSession.mockRejectedValueOnce(new Error('REPO_NOT_TRUSTED'))
    api.repoTrust.mockResolvedValueOnce(TRUSTED).mockResolvedValueOnce({ ...TRUSTED, trusted: false, configHash: 'h2' })
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'bonjour')
    const sending = submit(id)
    await vi.waitFor(() => expect(useSessions.getState().trustPrompt).not.toBeNull())
    useSessions.getState().trustPrompt?.answer(true)
    await sending

    expect(api.trustRepo).toHaveBeenCalledWith(CWD, 'h2')
    expect(api.startSession).toHaveBeenCalledTimes(2)
    expect(activeTab().localId).toBe('local-1')
  })

  it('gives the message back, without a bubble, when that second prompt is refused', async () => {
    api.startSession.mockRejectedValueOnce(new Error('REPO_NOT_TRUSTED'))
    api.repoTrust.mockResolvedValueOnce(TRUSTED).mockResolvedValueOnce({ ...TRUSTED, trusted: false, configHash: 'h2' })
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'bonjour')
    const sending = submit(id)
    await vi.waitFor(() => expect(useSessions.getState().trustPrompt).not.toBeNull())
    useSessions.getState().trustPrompt?.answer(false)
    await sending

    expect(activeTab()).toMatchObject({ state: 'draft', draft: { text: 'bonjour', images: [] } })
    expect(activeTab().transcript.items).toEqual([])
    expect(activeTab().error).toBeUndefined()
  })

  it('resumes when the process ended without the tab knowing', async () => {
    await openSession(CWD, PAST)
    const { id } = activeTab()
    useSessions.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], localId: 'gone' } } }))
    api.sendToSession.mockRejectedValue(new Error('Cette session est terminée.'))
    setDraftText(id, 'encore')
    await submit(id)

    expect(api.startSession).toHaveBeenCalledWith(CWD, expect.objectContaining({ resumeId: 'past' }))
    expect(activeTab().localId).toBe('local-1')
  })

  it('sends a draft only once when submitted twice at the same time', async () => {
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'une fois')
    await Promise.all([submit(id), submit(id)])
    expect(api.startSession).toHaveBeenCalledTimes(1)
  })
})

describe('askClaude', () => {
  it('sends to the selected session of the worktree, resuming it, without opening another tab', async () => {
    await openSession(CWD, PAST)
    const { id } = activeTab()
    askClaude(CWD, 'à propos de a.ts')
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1))
    expect(api.startSession.mock.calls[0][1]).toMatchObject({ content: { text: 'à propos de a.ts' }, resumeId: 'past' })
    expect(tabs()).toHaveLength(1)
    expect(activeTab().id).toBe(id)
  })

  it('starts a new session when there is none', async () => {
    askClaude(CWD, 'bonjour')
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1))
    expect(api.startSession.mock.calls[0][1]).toMatchObject({ content: { text: 'bonjour' } })
  })

  describe('expectLinear', () => {
    const live = (fields: Partial<SessionTab>): string => {
      ensureTab(CWD)
      const id = activeTab().id
      useSessions.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], localId: 'live', ...fields } } }))
      return id
    }
    const NOTICE = 'Claude n’a pas accès à Linear dans cette session.'

    it('a reused live tab without a Linear server shows the notice, and sets no flag', () => {
      const id = live({ mcpServers: [{ name: 'github', status: 'connected' }] })
      askClaude(CWD, 'x', { expectLinear: true })
      expect(useSessions.getState().tabs[id].notice).toBe(NOTICE)
      expect(useSessions.getState().tabs[id].expectLinear).toBeUndefined()
    })

    it('a reused live tab with a connected Linear server shows no notice', () => {
      const id = live({ mcpServers: [{ name: 'linear', status: 'connected' }] })
      askClaude(CWD, 'x', { expectLinear: true })
      expect(useSessions.getState().tabs[id].notice).toBeUndefined()
      expect(useSessions.getState().tabs[id].expectLinear).toBeUndefined()
    })

    it('a live tab with no init yet judges the first init, once', async () => {
      let onMsg: (p: unknown) => void = () => undefined
      ;(window.canopy as unknown as Record<string, unknown>).pendingPermissions = async () => []
      ;(window.canopy as unknown as { on: unknown }).on = (k: string, cb: (p: unknown) => void) => { if (k === 'session:message') onMsg = cb; return () => undefined }
      const { connectSessions } = await import('../../src/renderer/sessions/sessionStore')
      const off = connectSessions()
      const id = live({})
      askClaude(CWD, 'x', { expectLinear: true })
      expect(useSessions.getState().tabs[id].expectLinear).toBe(true)
      onMsg({ localId: 'live', msg: { type: 'system', subtype: 'init', mcp_servers: [] } })
      expect(useSessions.getState().tabs[id].notice).toBe(NOTICE)
      expect(useSessions.getState().tabs[id].expectLinear).toBeUndefined()
      off()
    })

    it('the flag is cleared once launch passed it: a later resume sends none', async () => {
      askClaude(CWD, 'x', { expectLinear: true })
      await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1))
      expect(api.startSession.mock.calls[0][1]).toMatchObject({ expectLinear: true })
      await vi.waitFor(() => expect(activeTab().expectLinear).toBeUndefined())
      useSessions.setState((s) => ({ tabs: { ...s.tabs, [activeTab().id]: { ...activeTab(), localId: undefined, sessionId: 'sid', resumable: true } } }))
      void submit(activeTab().id)
      setDraftText(activeTab().id, 'again')
      await submit(activeTab().id)
      await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(2))
      expect(api.startSession.mock.calls[1][1]).not.toHaveProperty('expectLinear')
    })
  })

  it('leaves a half-typed draft alone and uses a new tab', async () => {
    ensureTab(CWD)
    const typing = activeTab().id
    setDraftText(typing, 'en cours')
    askClaude(CWD, 'question')
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1))
    expect(tabs()).toHaveLength(2)
    expect(useSessions.getState().tabs[typing].draft.text).toBe('en cours')
  })
})

describe('closeActiveTabIfSafe', () => {
  const open = (fields: Partial<SessionTab>): string => {
    ensureTab(CWD)
    const id = activeTab().id
    useSessions.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], ...fields } } }))
    return id
  }

  it('closes a finished tab', () => {
    const id = open({ state: 'idle', localId: 'local-1' })
    closeActiveTabIfSafe(CWD)
    expect(useSessions.getState().tabs[id]).toBeUndefined()
    expect(api.stopSession).toHaveBeenCalledWith('local-1')
  })

  it.each(['running', 'waiting'] as const)('leaves a %s session alone', (state) => {
    const id = open({ state, localId: 'local-1' })
    closeActiveTabIfSafe(CWD)
    expect(useSessions.getState().tabs[id]).toBeDefined()
    expect(api.stopSession).not.toHaveBeenCalled()
  })

  it('leaves a tab with a draft alone', () => {
    const id = open({ state: 'idle', draft: { text: 'à finir', images: [] } })
    closeActiveTabIfSafe(CWD)
    expect(useSessions.getState().tabs[id]).toBeDefined()
  })
})

describe('documents in the draft', () => {
  const doc = { name: 'spec.pdf', base64: 'AAAA' }

  it('a draft holding only a document is sent with it, shown and emptied', async () => {
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftDocuments(id, (current) => [...current, doc])
    await submit(id)
    expect(api.startSession).toHaveBeenCalledWith(CWD, expect.objectContaining({ content: { text: '', documents: [doc] } }))
    expect(activeTab().transcript.items.at(-1)).toEqual({ kind: 'user', text: '', images: [], documents: [{ name: 'spec.pdf' }] })
    expect(activeTab().draft.documents ?? []).toEqual([])
  })

  it('a document added while the message is being sent stays in the draft', async () => {
    let trusted!: (t: typeof TRUSTED) => void
    api.repoTrust.mockImplementationOnce(() => new Promise((r) => { trusted = r }))
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'lis')
    setDraftDocuments(id, () => [doc])
    const sending = submit(id)
    await vi.waitFor(() => expect(api.repoTrust).toHaveBeenCalled())
    const late = { name: 'late.pdf', base64: 'BBBB' }
    setDraftDocuments(id, (current) => [...current, late])
    trusted(TRUSTED)
    await sending
    expect(api.startSession).toHaveBeenCalledWith(CWD, expect.objectContaining({ content: { text: 'lis', documents: [doc] } }))
    expect(activeTab().draft).toEqual({ text: '', images: [], documents: [late] })
  })

  it('a message that fails to go comes back with what was attached meanwhile', async () => {
    let started!: (v: unknown) => void
    api.startSession.mockImplementationOnce(() => new Promise((_r, reject) => { started = reject }))
    ensureTab(CWD)
    const { id } = activeTab()
    setDraftText(id, 'lis')
    setDraftDocuments(id, () => [doc])
    const sending = submit(id)
    await vi.waitFor(() => expect(api.startSession).toHaveBeenCalled())
    const late = { name: 'late.pdf', base64: 'BBBB' }
    setDraftDocuments(id, (current) => [...current, late])
    started(new Error('boom'))
    await sending
    expect(activeTab().draft).toEqual({ text: 'lis', images: [], documents: [doc, late] })
  })

  it('a document alone counts as a draft', () => {
    ensureTab(CWD)
    setDraftDocuments(activeTab().id, () => [doc])
    expect(composerDraftCount()).toBe(1)
  })
})

describe('composerDraftCount', () => {
  it('counts the tabs holding text or an image', () => {
    ensureTab(CWD)
    expect(composerDraftCount()).toBe(0)
    setDraftText(activeTab().id, 'x')
    expect(composerDraftCount()).toBe(1)
    setDraftText(activeTab().id, '   ')
    expect(composerDraftCount()).toBe(0)
  })
})

describe('modeFrom', () => {
  const message = (m: Record<string, unknown>): Parameters<typeof modeFrom>[0] => m as unknown as Parameters<typeof modeFrom>[0]

  it('reads the mode of init and status messages', () => {
    expect(modeFrom(message({ type: 'system', subtype: 'init', permissionMode: 'plan' }))).toBe('plan')
    expect(modeFrom(message({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' }))).toBe('default')
  })

  it('ignores a status without a mode, other messages, and a mode the selector cannot show', () => {
    expect(modeFrom(message({ type: 'system', subtype: 'status', status: 'requesting' }))).toBeUndefined()
    expect(modeFrom(message({ type: 'assistant', permissionMode: 'plan' }))).toBeUndefined()
    expect(modeFrom(message({ type: 'system', subtype: 'init', permissionMode: 'bypassPermissions' }))).toBeUndefined()
  })
})
