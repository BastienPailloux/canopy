import { editPrompt, parseArtifactUrl, publishedUrls, type Mockup } from '../../shared/mockups'
import { newTab, setDraftText, submit, useSessions } from '../sessions/sessionStore'
import { useApp } from '../store'
import { upsertMockup } from './mockupStore'

/**
 * The session tab of each mockup's conversation, by main checkout and mockup id (or `'new'`), for as long as the app
 * runs: a restart begins new ones, the old ones stay in the Sessions history of the main checkout.
 */
const chats = new Map<string, string>()
/** Tool calls already looked at, per tab: a publish is acted on once, however often the editor mounts. */
const handled = new Set<string>()

const chatKey = (cwd: string, key: string): string => `${cwd}\0${key}`

/** The tab of the conversation about `key` in `cwd`, while it is open. */
export function chatTab(cwd: string, key: string): string | undefined {
  const id = chats.get(chatKey(cwd, key))
  return id && useSessions.getState().tabs[id] ? id : undefined
}

/** The conversation that created a mockup goes on as that mockup's. */
export function rekeyChat(cwd: string, from: string, to: string): void {
  const id = chats.get(chatKey(cwd, from))
  if (id === undefined) return
  chats.delete(chatKey(cwd, from))
  chats.set(chatKey(cwd, to), id)
}

/** Tests only. */
export function resetChats(): void {
  chats.clear()
  handled.clear()
}

/**
 * Sends the user's request about `mockup` (null: one to create) to its conversation in the main checkout `cwd`,
 * opening the tab the first time (`onTab` learns it before the message goes). The first message of a tab carries the context. Resolves the tab and whether the
 * message went; when it did not, the tab's draft is emptied (the caller keeps the user's text).
 */
export async function sendEdit(
  cwd: string, mockup: Mockup | null, text: string, variant: boolean, onTab?: (id: string) => void
): Promise<{ tab: string; sent: boolean }> {
  const key = mockup?.id ?? 'new'
  let id = chatTab(cwd, key)
  if (!id) {
    id = newTab(cwd)
    chats.set(chatKey(cwd, key), id)
  }
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

/**
 * Calls `onUrls` with the mockup URLs of each Artifact publish of tab `tabId` that finished without error, once per
 * tool call, including the ones that finished before the watch began. Returns the stop function.
 */
export function watchPublishes(tabId: string, onUrls: (urls: string[]) => void): () => void {
  const check = (): void => {
    const tab = useSessions.getState().tabs[tabId]
    if (!tab) return
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
  check()
  return useSessions.subscribe((s, prev) => { if (s.tabs[tabId] !== prev.tabs[tabId]) check() })
}

/**
 * What a publish of the conversation about `current` (null: a creation) does: its own URL reloads the view; any other
 * is registered with the same ticket and template. In a creation, the first URL becomes the mockup: the editor moves
 * to it, the conversation follows, and it takes the ticket the creation was asked from.
 */
export async function applyPublished(repo: string, cwd: string, current: Mockup | null, urls: string[]): Promise<void> {
  let base = current
  for (const raw of urls) {
    const parsed = parseArtifactUrl(raw)
    if (!parsed) continue
    if (base && parsed.id === base.id) {
      void window.canopy.reloadMockupView().catch(() => undefined)
      continue
    }
    const ticket = base ? base.ticket : useApp.getState().pendingMockupTicket ?? undefined
    const m = await window.canopy.addMockup(repo, parsed.url, { kind: base?.kind ?? 'web', ...(ticket ? { ticket } : {}) })
    upsertMockup(repo, m)
    if (base) continue
    base = m
    rekeyChat(cwd, 'new', m.id)
    const app = useApp.getState()
    if (app.repo !== repo) continue
    app.setPendingMockupTicket(null)
    app.setSelectedMockup(m.id)
    if (app.openMockup === 'new') app.setOpenMockup(m.id)
  }
}
