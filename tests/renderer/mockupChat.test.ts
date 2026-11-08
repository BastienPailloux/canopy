import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editPrompt, type Mockup } from '../../src/shared/mockups'
import { applyPublished, chatTab, resetChats, sendEdit, watchPublishes } from '../../src/renderer/mockups/mockupChat'
import { useMockups } from '../../src/renderer/mockups/mockupStore'
import { type SessionTab, useSessions } from '../../src/renderer/sessions/sessionStore'
import { emptyTranscript, type TranscriptItem } from '../../src/renderer/sessions/transcript'
import { useApp } from '../../src/renderer/store'

const ID = 'WcXTxNhxSWaDL28ttqjZye'
const OTHER = 'AbCdEfGhIjKlMnOpQrStUv'
const url = (id: string): string => `https://claude.ai/artifact/${id}`
const mk = (id: string, o: Partial<Mockup> = {}): Mockup => ({
  id, url: url(id), title: id, kind: 'phone', status: 'todo', added: '', updated: '', ...o
})

const tool = (id: string, o: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): TranscriptItem => ({
  kind: 'tool', id, name: 'Artifact', input: { action: 'publish' }, result: `Publié : ${url(ID)}`, running: false, ...o
})

function setTab(items: TranscriptItem[]): void {
  const tab: SessionTab = {
    id: 'T', cwd: '/r', resumable: false, title: 't', state: 'running', transcript: { ...emptyTranscript(), items },
    draft: { text: '', images: [] }, mode: 'default', commands: [], models: []
  }
  useSessions.setState({ tabs: { T: tab }, active: { '/r': 'T' } })
}

beforeEach(() => {
  resetChats()
  useSessions.setState({ tabs: {}, active: {}, permissions: [], summaries: {} })
})

describe('watchPublishes', () => {
  it('reports each finished, successful publish once, including those done before the watch', () => {
    setTab([tool('a')])
    const seen: string[][] = []
    const stop = watchPublishes('T', (u) => seen.push(u))
    expect(seen).toEqual([[url(ID)]])

    // Running, failed, other tools, other actions, no result: nothing.
    setTab([tool('a'), tool('b', { running: true }), tool('c', { isError: true }), tool('d', { name: 'Read' }),
      tool('e', { input: { action: 'read' } }), tool('f', { result: undefined })])
    expect(seen).toHaveLength(1)

    // `b` finishes: reported once, however many updates follow.
    setTab([tool('a'), tool('b', { result: `ok ${url(OTHER)}` })])
    setTab([tool('a'), tool('b', { result: `ok ${url(OTHER)}` }), { kind: 'notice', text: 'x' }])
    expect(seen).toEqual([[url(ID)], [url(OTHER)]])
    stop()

    // A second watch of the same tab (the editor mounted again) does not repeat them.
    const again: string[][] = []
    watchPublishes('T', (u) => again.push(u))()
    expect(again).toEqual([])
  })

  it('stops reporting once stopped', () => {
    setTab([])
    const seen: string[][] = []
    watchPublishes('T', (u) => seen.push(u))()
    setTab([tool('a')])
    expect(seen).toEqual([])
  })
})

describe('sendEdit', () => {
  let started: string[]
  beforeEach(() => {
    started = []
    vi.stubGlobal('window', {
      canopy: {
        repoTrust: async () => ({ trusted: true }),
        startSession: async (_cwd: string, o: { content: { text: string } }) => { started.push(o.content.text); return 'L1' },
        sendToSession: async (_l: string, c: { text: string }) => { started.push(c.text) },
        sessionCommands: async () => [],
        sessionModels: async () => []
      }
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens the tab in the main checkout once, the first message with the context, the next ones without', async () => {
    const m = mk(ID)
    const first = await sendEdit('/r', m, 'Ajoute un bouton', false)
    expect(first.sent).toBe(true)
    expect(chatTab('/r', ID)).toBe(first.tab)
    expect(useSessions.getState().tabs[first.tab].cwd).toBe('/r')
    const second = await sendEdit('/r', m, 'Plus grand', true)
    expect(second.tab).toBe(first.tab)
    expect(started).toEqual([
      editPrompt({ url: m.url, text: 'Ajoute un bouton', first: true, variant: false }),
      editPrompt({ url: m.url, text: 'Plus grand', first: false, variant: true })
    ])
  })

  it('a creation asks Claude to publish a new mockup; another repo has its own conversation', async () => {
    const a = await sendEdit('/r', null, 'Un écran de login', false)
    expect(started[0]).toBe(editPrompt({ text: 'Un écran de login', first: true, variant: false }))
    const b = await sendEdit('/s', null, 'Autre', false)
    expect(b.tab).not.toBe(a.tab)
  })
})

describe('applyPublished', () => {
  let addMockup: ReturnType<typeof vi.fn>
  let reloadMockupView: ReturnType<typeof vi.fn>
  beforeEach(() => {
    addMockup = vi.fn(async (_r: string, u: string, f: Partial<Mockup>) => mk(u.slice(-22), { ...f, title: 'Maquette sans titre' }))
    reloadMockupView = vi.fn(async () => undefined)
    vi.stubGlobal('window', { canopy: { addMockup, reloadMockupView } })
    useApp.setState({ repo: '/r', openMockup: ID, selectedMockup: null, pendingMockupTicket: null })
    useMockups.setState({ repo: '/r', list: [mk(ID, { ticket: 'A-1' })], error: null, loaded: true })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('its own URL reloads the view; another is added with the same ticket and template', async () => {
    await applyPublished('/r', '/r', mk(ID, { ticket: 'A-1' }), [url(ID), url(OTHER)])
    expect(reloadMockupView).toHaveBeenCalledTimes(1)
    expect(addMockup).toHaveBeenCalledWith('/r', url(OTHER), { kind: 'phone', ticket: 'A-1' })
    expect(useMockups.getState().list.map((m) => m.id)).toEqual([ID, OTHER])
    expect(useApp.getState().openMockup).toBe(ID)
  })

  it('in a creation, the first URL becomes the mockup, with the pending ticket, and the conversation follows', async () => {
    vi.stubGlobal('window', {
      canopy: {
        addMockup, reloadMockupView,
        repoTrust: async () => ({ trusted: true }), startSession: async () => 'L1', sessionCommands: async () => [], sessionModels: async () => []
      }
    })
    const { tab } = await sendEdit('/r', null, 'Crée', false)
    useApp.setState({ openMockup: 'new', pendingMockupTicket: 'A-7' })
    await applyPublished('/r', '/r', null, [url(OTHER), url(ID)])
    expect(addMockup).toHaveBeenNthCalledWith(1, '/r', url(OTHER), { kind: 'web', ticket: 'A-7' })
    expect(addMockup).toHaveBeenNthCalledWith(2, '/r', url(ID), { kind: 'web', ticket: 'A-7' })
    expect(useApp.getState()).toMatchObject({ openMockup: OTHER, selectedMockup: OTHER, pendingMockupTicket: null })
    expect(chatTab('/r', OTHER)).toBe(tab)
    expect(chatTab('/r', 'new')).toBeUndefined()
  })
})
