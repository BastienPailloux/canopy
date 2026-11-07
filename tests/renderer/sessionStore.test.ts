import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopyApi } from '../../src/shared/api'
import type { SessionSummary } from '../../src/shared/types'
import { ensureTab, openSession, setDraftText, submit, useSessions, type SessionTab } from '../../src/renderer/sessions/sessionStore'

const CWD = '/repo'
const PAST: SessionSummary = { sessionId: 'past', title: 'Ancienne', lastModified: 1, live: false, state: 'stopped' }
const HISTORY = [
  { type: 'user', uuid: 'a', session_id: 'past', parent_tool_use_id: null, message: { role: 'user', content: 'salut' } },
  { type: 'assistant', uuid: 'b', session_id: 'past', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'OK' }] } }
] as unknown as SessionMessage[]

let api: { [K in 'repoTrust' | 'trustRepo' | 'startSession' | 'sendToSession' | 'sessionHistory' | 'sessionCommands' | 'sessionModels']: ReturnType<typeof vi.fn> }

const tabs = (): SessionTab[] => Object.values(useSessions.getState().tabs)
const activeTab = (): SessionTab => useSessions.getState().tabs[useSessions.getState().active[CWD]]

beforeEach(() => {
  useSessions.setState({ tabs: {}, active: {}, permissions: [], summaries: {}, trustPrompt: null })
  api = {
    repoTrust: vi.fn(async () => ({ trusted: true, hooks: [], mcpServers: [], allowRules: [], apiKeyHelper: [], statusLine: [], env: [] })),
    trustRepo: vi.fn(async () => undefined),
    startSession: vi.fn(async () => 'local-1'),
    sendToSession: vi.fn(async () => undefined),
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
