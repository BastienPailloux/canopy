import { create } from 'zustand'
import { editPrompt, parseArtifactUrl, publishedUrls, type Mockup, type MockupKind } from '../../shared/mockups'
import { newTab, setDraftText, submit, useSessions } from '../sessions/sessionStore'
import { useApp } from '../store'
import { upsertMockup, useMockups } from './mockupStore'

/**
 * A mockup's conversation: a session tab of the main checkout, kept for as long as the app runs and the tab is open
 * (a restart begins new ones; the old ones stay in the Sessions history). Its publishes are watched from the first
 * message on, whatever screen shows, and applied one after the other.
 */
interface Chat {
  repo: string
  cwd: string
  tab: string
  /** The mockup the conversation is about; null for a creation until its first publish is registered. */
  mockup: string | null
  /** Taken at the first message of a creation: what the mockup it publishes gets. Later, the mockup's own decide. */
  ticket?: string
  kind: MockupKind
  /** Publishes are applied in order: a second one during the first registration must not create twice. */
  queue: Promise<void>
  stop: (() => void) | null
}

/** Chats by main checkout and key: the mockup id, `'new'` for the creation on screen, `pending:<tab>` for older ones. */
const chats = new Map<string, Chat>()
/** Tool calls already looked at, per tab: a publish is acted on once. */
const handled = new Set<string>()

const chatKey = (cwd: string, key: string): string => `${cwd}\0${key}`

/** The last publish that could not be registered, for the edit screen to show. */
export const usePublishError = create<{ text: string | null }>(() => ({ text: null }))

/** The tab of the conversation about `key` in `cwd`, while it is open. */
export function chatTab(cwd: string, key: string): string | undefined {
  const chat = chats.get(chatKey(cwd, key))
  return chat && useSessions.getState().tabs[chat.tab] ? chat.tab : undefined
}

/** Tests only. */
export function resetChats(): void {
  for (const c of chats.values()) c.stop?.()
  chats.clear()
  handled.clear()
  usePublishError.setState({ text: null })
}

/**
 * Opens the creation screen for a new mockup to link to `ticket` (null: none). A creation already asked of Claude and
 * still waiting for its publish keeps its own conversation and ticket; the screen starts a fresh one. A creation whose
 * tab is open but nothing was asked yet (its first send failed) is reused, now for `ticket`.
 */
export function startCreation(ticket: string | null): void {
  const app = useApp.getState()
  const cwd = app.worktrees.find((w) => w.isMain)?.path
  const key = cwd ? chatKey(cwd, 'new') : null
  const waiting = key ? chats.get(key) : undefined
  const tab = waiting ? useSessions.getState().tabs[waiting.tab] : undefined
  let pending = ticket
  if (key && waiting && tab) {
    if (tab.transcript.items.some((i) => i.kind === 'user')) {
      chats.delete(key)
      chats.set(chatKey(waiting.cwd, `pending:${waiting.tab}`), waiting)
    } else {
      // The next send goes to this conversation: it takes the ticket now, none is left pending.
      if (ticket) waiting.ticket = ticket
      else delete waiting.ticket
      pending = null
    }
  }
  app.setPendingMockupTicket(pending)
  app.setOpenMockup('new')
  app.setView('mockups')
}

/**
 * Calls `onUrls` with the mockup URLs of each Artifact publish of tab `tabId` that finished without error, once per
 * tool call, including the ones that finished before the watch began. Stops by itself once the tab is closed
 * (then calls `onGone`). Returns the stop function.
 */
export function watchPublishes(tabId: string, onUrls: (urls: string[]) => void, onGone?: () => void): () => void {
  let unsub: (() => void) | null = null
  const stop = (): void => { unsub?.(); unsub = null }
  const check = (): void => {
    const tab = useSessions.getState().tabs[tabId]
    if (!tab) {
      stop()
      onGone?.()
      return
    }
    for (const item of tab.transcript.items) {
      if (item.kind !== 'tool' || item.running) continue
      const key = `${tabId}\0${item.id}`
      if (handled.has(key)) continue
      handled.add(key)
      // Ended without a result (the session stopped meanwhile): nothing was published for sure.
      if (item.result === undefined) continue
      const urls = publishedUrls(item)
      if (urls.length > 0) onUrls(urls)
    }
  }
  unsub = useSessions.subscribe((s, prev) => { if (s.tabs[tabId] !== prev.tabs[tabId]) check() })
  check()
  return stop
}

function openChat(repo: string, cwd: string, key: string, mockup: Mockup | null): Chat {
  const app = useApp.getState()
  const chat: Chat = {
    repo,
    cwd,
    tab: newTab(cwd),
    mockup: mockup?.id ?? null,
    kind: mockup?.kind ?? 'web',
    queue: Promise.resolve(),
    stop: null,
    ...(mockup ? (mockup.ticket ? { ticket: mockup.ticket } : {}) : app.pendingMockupTicket ? { ticket: app.pendingMockupTicket } : {})
  }
  // The creation took its ticket: a later one must not find it.
  if (!mockup) app.setPendingMockupTicket(null)
  chats.set(chatKey(cwd, key), chat)
  chat.stop = watchPublishes(chat.tab, (urls) => {
    chat.queue = chat.queue
      .then(() => applyPublished(chat, urls))
      .catch((e: unknown) => usePublishError.setState({ text: `Maquette publiée non enregistrée : ${e instanceof Error ? e.message : String(e)}` }))
  }, () => {
    for (const [k, c] of chats) if (c === chat) chats.delete(k)
  })
  return chat
}

/**
 * Sends the user's request about `mockup` (null: one to create) to its conversation in the main checkout `cwd` of
 * `repo`, opening the tab the first time (`onTab` learns it before the message goes). The first message of a tab
 * carries the context. Resolves the tab and whether the message went; when it did not, the tab's draft is emptied
 * (the caller keeps the user's text).
 */
export async function sendEdit(
  repo: string, cwd: string, mockup: Mockup | null, text: string, variant: boolean, onTab?: (id: string) => void
): Promise<{ tab: string; sent: boolean }> {
  const key = mockup?.id ?? 'new'
  const known = chats.get(chatKey(cwd, key))
  const chat = known && useSessions.getState().tabs[known.tab] ? known : openChat(repo, cwd, key, mockup)
  const id = chat.tab
  onTab?.(id)
  const first = !useSessions.getState().tabs[id]?.transcript.items.some((i) => i.kind === 'user')
  const prompt = editPrompt({ ...(mockup ? { url: mockup.url } : {}), text, first, variant })
  setDraftText(id, prompt)
  await submit(id)
  const left = useSessions.getState().tabs[id]?.draft.text
  const sent = left !== prompt
  if (!sent) setDraftText(id, '')
  return { tab: id, sent }
}

/** The mockup on screen in 4b, if any. */
const shown = (repo: string): string | null => {
  const app = useApp.getState()
  return app.repo === repo && app.view === 'mockups' ? app.openMockup : null
}

/**
 * What a publish of `chat` does: the mockup's own URL reloads the view if it shows; any other is registered with the
 * mockup's ticket and template. In a creation, the first URL becomes the mockup, with the ticket taken at its first
 * message; the creation screen, if it still shows this conversation, moves to it.
 */
async function applyPublished(chat: Chat, urls: string[]): Promise<void> {
  for (const raw of urls) {
    const parsed = parseArtifactUrl(raw)
    if (!parsed) continue
    if (chat.mockup && parsed.id === chat.mockup) {
      if (shown(chat.repo) === chat.mockup) void window.canopy.reloadMockupView().catch(() => undefined)
      continue
    }
    const { list, repo: listed } = useMockups.getState()
    const base = chat.mockup && listed === chat.repo ? list.find((m) => m.id === chat.mockup) : undefined
    const ticket = base ? base.ticket : chat.ticket
    const kind = base?.kind ?? chat.kind
    const m = await window.canopy.addMockup(chat.repo, parsed.url, { kind, ...(ticket ? { ticket } : {}) })
    upsertMockup(chat.repo, m)
    if (chat.mockup) continue
    chat.mockup = m.id
    // On screen while the creation screen shows it under 'new'.
    const onScreen = chats.get(chatKey(chat.cwd, 'new')) === chat && shown(chat.repo) === 'new'
    for (const [k, c] of chats) if (c === chat) chats.delete(k)
    chats.set(chatKey(chat.cwd, m.id), chat)
    if (onScreen) {
      const app = useApp.getState()
      app.setSelectedMockup(m.id)
      app.setOpenMockup(m.id)
    }
  }
}
