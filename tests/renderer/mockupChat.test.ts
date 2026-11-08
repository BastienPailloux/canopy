import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editPrompt, type Mockup } from '../../src/shared/mockups'
import { chatTab, resetChats, sendEdit, startCreation, usePublishError, watchPublishes } from '../../src/renderer/mockups/mockupChat'
import { useMockups } from '../../src/renderer/mockups/mockupStore'
import { type SessionTab, useSessions } from '../../src/renderer/sessions/sessionStore'
import { emptyTranscript, type TranscriptItem } from '../../src/renderer/sessions/transcript'
import { useApp } from '../../src/renderer/store'

const ID = 'WcXTxNhxSWaDL28ttqjZye'
const OTHER = 'AbCdEfGhIjKlMnOpQrStUv'
const THIRD = 'ZzYyXxWwVvUuTtSsRrQqPp'
const url = (id: string): string => `https://claude.ai/artifact/${id}`
const mk = (id: string, o: Partial<Mockup> = {}): Mockup => ({
  id, url: url(id), title: id, kind: 'phone', status: 'todo', added: '', updated: '', ...o
})

const tool = (id: string, o: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): TranscriptItem => ({
  kind: 'tool', id, name: 'Artifact', input: { action: 'publish' }, result: `Publié : ${url(ID)}`, running: false, ...o
})
const published = (id: string, ...ids: string[]): TranscriptItem => tool(id, { result: `ok ${ids.map(url).join(' ')}` })

function setTab(items: TranscriptItem[]): void {
  const tab: SessionTab = {
    id: 'T', cwd: '/r', resumable: false, title: 't', state: 'running', transcript: { ...emptyTranscript(), items },
    draft: { text: '', images: [] }, mode: 'default', commands: [], models: []
  }
  useSessions.setState({ tabs: { T: tab }, active: { '/r': 'T' } })
}

/** Adds `item` to the transcript of tab `id`, as a finished tool call would. */
function addItem(id: string, item: TranscriptItem): void {
  useSessions.setState((s) => {
    const tab = s.tabs[id]
    return { tabs: { ...s.tabs, [id]: { ...tab, transcript: { ...tab.transcript, items: [...tab.transcript.items, item] } } } }
  })
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

let started: string[]
let addMockup: ReturnType<typeof vi.fn>
let reloadMockupView: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetChats()
  started = []
  useSessions.setState({ tabs: {}, active: {}, permissions: [], summaries: {} })
  useApp.setState({
    repo: '/r', view: 'mockups', openMockup: null, selectedMockup: null, pendingMockupTicket: null,
    worktrees: [{ path: '/r', branch: 'main', head: 'a', isMain: true }]
  })
  useMockups.setState({ repo: '/r', list: [mk(ID, { ticket: 'A-1' })], error: null, loaded: true })
  addMockup = vi.fn(async (_r: string, u: string, f: Partial<Mockup>) => mk(u.slice(-22), { ...f, title: 'Maquette sans titre' }))
  reloadMockupView = vi.fn(async () => undefined)
  vi.stubGlobal('window', {
    canopy: {
      repoTrust: async () => ({ trusted: true }),
      startSession: async (_cwd: string, o: { content: { text: string } }) => { started.push(o.content.text); return `L${started.length}` },
      sendToSession: async (_l: string, c: { text: string }) => { started.push(c.text) },
      sessionCommands: async () => [],
      sessionModels: async () => [],
      addMockup,
      reloadMockupView
    }
  })
})
afterEach(() => { resetChats(); vi.unstubAllGlobals() })

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
    setTab([tool('a'), published('b', OTHER)])
    setTab([tool('a'), published('b', OTHER), { kind: 'notice', text: 'x' }])
    expect(seen).toEqual([[url(ID)], [url(OTHER)]])
    stop()

    // A second watch of the same tab does not repeat them.
    const again: string[][] = []
    watchPublishes('T', (u) => again.push(u))()
    expect(again).toEqual([])
  })

  it('stops reporting once stopped, and by itself once the tab is gone', () => {
    setTab([])
    const seen: string[][] = []
    watchPublishes('T', (u) => seen.push(u))()
    setTab([tool('a')])
    expect(seen).toEqual([])

    const gone = vi.fn()
    const later: string[][] = []
    watchPublishes('T', (u) => later.push(u), gone)
    expect(later).toEqual([[url(ID)]])
    useSessions.setState({ tabs: {} })
    expect(gone).toHaveBeenCalledTimes(1)
    setTab([tool('a'), tool('z')])
    expect(later).toHaveLength(1)
  })
})

describe('sendEdit', () => {
  it('opens the tab in the main checkout once, the first message with the context, the next ones without', async () => {
    const m = mk(ID)
    const first = await sendEdit('/r', '/r', m, 'Ajoute un bouton', false)
    expect(first.sent).toBe(true)
    expect(chatTab('/r', ID)).toBe(first.tab)
    expect(useSessions.getState().tabs[first.tab].cwd).toBe('/r')
    const second = await sendEdit('/r', '/r', m, 'Plus grand', true)
    expect(second.tab).toBe(first.tab)
    expect(started).toEqual([
      editPrompt({ url: m.url, text: 'Ajoute un bouton', first: true, variant: false }),
      editPrompt({ url: m.url, text: 'Plus grand', first: false, variant: true })
    ])
  })

  it('a creation asks Claude to publish a new mockup; another repo has its own conversation', async () => {
    const a = await sendEdit('/r', '/r', null, 'Un écran de login', false)
    expect(started[0]).toBe(editPrompt({ text: 'Un écran de login', first: true, variant: false }))
    const b = await sendEdit('/s', '/s', null, 'Autre', false)
    expect(b.tab).not.toBe(a.tab)
  })
})

describe('publishes of a mockup conversation', () => {
  it('its own URL reloads the view only while it shows; another is added with the mockup’s ticket and template', async () => {
    const { tab } = await sendEdit('/r', '/r', mk(ID, { ticket: 'A-1' }), 'x', false)
    useApp.setState({ openMockup: ID })
    addItem(tab, published('p1', ID, OTHER))
    await flush()
    expect(reloadMockupView).toHaveBeenCalledTimes(1)
    expect(addMockup).toHaveBeenCalledWith('/r', url(OTHER), { kind: 'phone', ticket: 'A-1' })
    expect(useMockups.getState().list.map((m) => m.id)).toEqual([ID, OTHER])

    useApp.setState({ view: 'sessions' })
    addItem(tab, published('p2', ID))
    await flush()
    expect(reloadMockupView).toHaveBeenCalledTimes(1)
  })
})

describe('publishes of a creation', () => {
  it('on screen: the first URL becomes the mockup with the pending ticket, the screen and the conversation follow', async () => {
    useApp.setState({ openMockup: 'new', pendingMockupTicket: 'A-7' })
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    expect(useApp.getState().pendingMockupTicket).toBeNull()
    addItem(tab, published('p1', OTHER, THIRD))
    await flush()
    expect(addMockup).toHaveBeenNthCalledWith(1, '/r', url(OTHER), { kind: 'web', ticket: 'A-7' })
    expect(addMockup).toHaveBeenNthCalledWith(2, '/r', url(THIRD), { kind: 'web', ticket: 'A-7' })
    expect(useApp.getState()).toMatchObject({ openMockup: OTHER, selectedMockup: OTHER })
    expect(chatTab('/r', OTHER)).toBe(tab)
    expect(chatTab('/r', 'new')).toBeUndefined()
  })

  it('published while no editor shows, after the pending ticket changed: registered with its own ticket, no navigation', async () => {
    useApp.setState({ openMockup: 'new', pendingMockupTicket: 'A-7' })
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    // The user leaves 4b, then asks another creation from another ticket.
    useApp.setState({ view: 'tickets', openMockup: null, pendingMockupTicket: 'B-1' })
    addItem(tab, published('p1', OTHER))
    await flush()
    expect(addMockup).toHaveBeenCalledWith('/r', url(OTHER), { kind: 'web', ticket: 'A-7' })
    expect(useApp.getState()).toMatchObject({ view: 'tickets', openMockup: null, pendingMockupTicket: 'B-1' })
    expect(useMockups.getState().list.find((m) => m.id === OTHER)?.ticket).toBe('A-7')
  })

  it('a second publish during the first registration is not another creation', async () => {
    let release: () => void = () => undefined
    addMockup.mockImplementationOnce((_r: string, u: string, f: Partial<Mockup>) =>
      new Promise((resolve) => { release = () => resolve(mk(u.slice(-22), { ...f })) }))
    useApp.setState({ openMockup: 'new', pendingMockupTicket: 'A-7' })
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    addItem(tab, published('p1', OTHER))
    addItem(tab, published('p2', OTHER, THIRD))
    await flush()
    expect(addMockup).toHaveBeenCalledTimes(1)
    release()
    await flush()
    // p2: OTHER is the mockup now (reloaded, not added again); THIRD is a variant with the same ticket.
    expect(addMockup).toHaveBeenCalledTimes(2)
    expect(addMockup).toHaveBeenLastCalledWith('/r', url(THIRD), { kind: 'web', ticket: 'A-7' })
    expect(reloadMockupView).toHaveBeenCalledTimes(1)
    expect(useApp.getState().openMockup).toBe(OTHER)
  })

  it('a new creation while one waits starts a fresh conversation; the old one still registers with its ticket', async () => {
    startCreation('A-7')
    const old = await sendEdit('/r', '/r', null, 'Première', false)
    startCreation('B-1')
    expect(chatTab('/r', 'new')).toBeUndefined()
    expect(useApp.getState()).toMatchObject({ openMockup: 'new', pendingMockupTicket: 'B-1' })
    const fresh = await sendEdit('/r', '/r', null, 'Seconde', false)
    expect(fresh.tab).not.toBe(old.tab)
    expect(started[1]).toBe(editPrompt({ text: 'Seconde', first: true, variant: false }))

    addItem(old.tab, published('p1', OTHER))
    await flush()
    expect(addMockup).toHaveBeenCalledWith('/r', url(OTHER), { kind: 'web', ticket: 'A-7' })
    // The screen shows the fresh creation: it stays there.
    expect(useApp.getState().openMockup).toBe('new')

    addItem(fresh.tab, published('p2', THIRD))
    await flush()
    expect(addMockup).toHaveBeenLastCalledWith('/r', url(THIRD), { kind: 'web', ticket: 'B-1' })
    expect(useApp.getState().openMockup).toBe(THIRD)
  })

  it('a creation not sent yet is reused by the next one, which brings its own ticket', async () => {
    startCreation('A-7')
    startCreation('B-1')
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    addItem(tab, published('p1', OTHER))
    await flush()
    expect(addMockup).toHaveBeenCalledWith('/r', url(OTHER), { kind: 'web', ticket: 'B-1' })
  })

  it('a creation whose first send failed takes the ticket of the next creation, or none', async () => {
    const startSession = window.canopy.startSession
    window.canopy.startSession = async () => { throw new Error('hors ligne') }
    startCreation('REP-1')
    const failed = await sendEdit('/r', '/r', null, 'Crée', false)
    expect(failed.sent).toBe(false)
    window.canopy.startSession = startSession

    startCreation('REP-2')
    expect(useApp.getState().pendingMockupTicket).toBeNull()
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    expect(tab).toBe(failed.tab)
    addItem(tab, published('p1', OTHER))
    await flush()
    expect(addMockup).toHaveBeenLastCalledWith('/r', url(OTHER), { kind: 'web', ticket: 'REP-2' })
  })

  it('from the gallery, a creation whose first send failed is linked to no ticket', async () => {
    const startSession = window.canopy.startSession
    window.canopy.startSession = async () => { throw new Error('hors ligne') }
    startCreation('REP-1')
    const failed = await sendEdit('/r', '/r', null, 'Crée', false)
    expect(failed.sent).toBe(false)
    window.canopy.startSession = startSession

    startCreation(null)
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    expect(tab).toBe(failed.tab)
    addItem(tab, published('p1', OTHER))
    await flush()
    expect(addMockup).toHaveBeenLastCalledWith('/r', url(OTHER), { kind: 'web' })
  })

  it('a registration that fails is reported', async () => {
    addMockup.mockRejectedValueOnce(new Error('disque plein'))
    const { tab } = await sendEdit('/r', '/r', null, 'Crée', false)
    addItem(tab, published('p1', OTHER))
    await flush()
    expect(usePublishError.getState().text).toContain('disque plein')
  })
})
