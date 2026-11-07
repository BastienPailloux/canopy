import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropDraft, dropDrafts, getDraft, setDraft } from '../../src/renderer/code/drafts'
import { useSessions, type SessionTab } from '../../src/renderer/sessions/sessionStore'
import { collectStash, connectUpdateStash, restoreStash, stillUnsaved, useRestoredFiles } from '../../src/renderer/update/stash'
import { keepOverMissing } from '../../src/renderer/code/draftOverMissing'
import type { Stash } from '../../src/shared/update'

const CWD = '/wt'
const reset = (): void => {
  useSessions.setState({ tabs: {}, active: {}, permissions: [], summaries: {}, trustPrompt: null })
  dropDrafts(CWD)
  useRestoredFiles.setState({ files: [] })
}
const tab = (over: Partial<SessionTab>): SessionTab => ({
  id: 't1', cwd: CWD, title: 'T', state: 'draft', resumable: false,
  transcript: { items: [] } as unknown as SessionTab['transcript'],
  draft: { text: '', images: [] }, mode: 'default', commands: [], models: [], ...over
})

beforeEach(() => {
  reset()
  vi.stubGlobal('window', { canopy: { sessionHistory: vi.fn(async () => []), submitStash: vi.fn(), on: vi.fn() } })
})

describe('stash', () => {
  it('collect then restore gives back drafts and tabs', async () => {
    setDraft(CWD, 'a.ts', { text: 'x', version: 'v1' })
    useSessions.setState({ tabs: { t1: tab({ sessionId: 's1', state: 'running', localId: 'p1', draft: { text: 'suite', images: [] } }) }, active: { [CWD]: 't1' } })
    const stash = collectStash()
    expect(stash.tabs).toHaveLength(1)
    expect(stash.tabs[0].interrupted).toBe(true)
    reset()
    restoreStash(stash)
    await vi.waitFor(() => expect(Object.keys(useSessions.getState().tabs)).toHaveLength(1))
    expect(getDraft(CWD, 'a.ts')).toEqual({ text: 'x', version: 'v1' })
    const [restored] = Object.values(useSessions.getState().tabs)
    expect(restored.sessionId).toBe('s1')
    expect(restored.resumable).toBe(true)
    expect(restored.localId).toBeUndefined()
    expect(restored.draft.text).toBe('suite')
    expect(restored.transcript.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Session interrompue par la mise à jour. Envoie un message pour la reprendre.' })
    expect(useRestoredFiles.getState().files).toEqual([{ cwd: CWD, path: 'a.ts', text: 'x', version: 'v1' }])
  })

  it('keeps a tab without session only when its draft is not empty', () => {
    useSessions.setState({ tabs: { a: tab({ id: 'a' }), b: tab({ id: 'b', draft: { text: 'hi', images: [] } }) }, active: {} })
    expect(collectStash().tabs.map((t) => t.title)).toEqual(['T'])
    expect(collectStash().tabs[0].sessionId).toBeUndefined()
  })

  it('restored draft over changed file keeps its original version', () => {
    restoreStash({ format: 1, buffers: [{ cwd: CWD, path: 'a.ts', text: 'x', version: 'old' }], tabs: [] })
    expect(getDraft(CWD, 'a.ts')?.version).toBe('old')
  })

  it('answers update:collectStash with the stash', () => {
    const on = vi.fn(() => () => undefined)
    const submitStash = vi.fn()
    vi.stubGlobal('window', { canopy: { on, submitStash } })
    connectUpdateStash()
    expect(on).toHaveBeenCalledWith('update:collectStash', expect.any(Function))
    const cb = (on.mock.calls[0] as unknown as [string, () => void])[1]
    cb()
    expect(submitStash).toHaveBeenCalledWith(collectStash())
  })

  it('a non-interrupted tab gets no notice', async () => {
    const s: Stash = { format: 1, buffers: [], tabs: [{ cwd: CWD, sessionId: 's2', title: 'X', draft: { text: '', images: [] }, interrupted: false }] }
    restoreStash(s)
    await vi.waitFor(() => expect(Object.keys(useSessions.getState().tabs)).toHaveLength(1))
    const [t] = Object.values(useSessions.getState().tabs)
    expect(t.transcript.items.some((i) => i.kind === 'notice' && i.text.startsWith('Session interrompue'))).toBe(false)
  })
})

describe('stillUnsaved', () => {
  it('keeps only the restored files whose draft is still there', () => {
    const a = { cwd: CWD, path: 'a.ts', text: 'x', version: 'v1' }
    const b = { cwd: CWD, path: 'b.ts', text: 'y', version: 'v1' }
    restoreStash({ format: 1, buffers: [a, b], tabs: [] })
    expect(stillUnsaved([a, b], getDraft)).toEqual([a, b])
    dropDraft(CWD, 'a.ts')
    expect(stillUnsaved([a, b], getDraft)).toEqual([b])
    expect(stillUnsaved([a, b], () => undefined)).toEqual([])
  })
})

describe('restoreTabs placement', () => {
  const stashed = (sessionId: string): Stash => ({ format: 1, buffers: [], tabs: [{ cwd: CWD, sessionId, title: 'X', draft: { text: '', images: [] }, interrupted: false }] })

  it('skips a tab whose session is already open in that cwd', async () => {
    useSessions.setState({ tabs: { o: tab({ id: 'o', sessionId: 's9', state: 'stopped' }) }, active: {} })
    restoreStash(stashed('s9'))
    await new Promise((r) => setTimeout(r, 20))
    expect(Object.keys(useSessions.getState().tabs)).toEqual(['o'])
  })

  it('removes untouched placeholder tabs of that cwd', async () => {
    useSessions.setState({ tabs: { p: tab({ id: 'p' }), q: tab({ id: 'q', cwd: '/other' }) }, active: {} })
    restoreStash(stashed('s8'))
    await vi.waitFor(() => expect(Object.values(useSessions.getState().tabs).some((t) => t.sessionId === 's8')).toBe(true))
    expect(Object.keys(useSessions.getState().tabs)).not.toContain('p')
    expect(Object.keys(useSessions.getState().tabs)).toContain('q')
  })
})

describe('keepOverMissing', () => {
  const draft = { text: 'typed', version: 'v1' }
  it('keeps the draft with a message when the file is gone', () => {
    expect(keepOverMissing({ kind: 'error', message: 'ENOENT' }, draft)).toEqual({
      work: { kind: 'text', content: '', version: 'v1' }, text: 'typed'
    })
    expect(keepOverMissing({ kind: 'missing' }, draft)?.text).toBe('typed')
  })
  it('leaves other outcomes alone', () => {
    expect(keepOverMissing({ kind: 'text', content: 'a', version: 'v2' }, draft)).toBeNull()
    expect(keepOverMissing({ kind: 'error', message: 'x' }, undefined)).toBeNull()
  })
})
