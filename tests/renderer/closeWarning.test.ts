import { expect, test } from 'vitest'
import { closeWarning } from '../../src/renderer/sessions/SessionTabs'
import type { SessionTab } from '../../src/renderer/sessions/sessionStore'

const tab = (over: Partial<SessionTab>): SessionTab =>
  ({ title: 'Refactor', state: 'idle', draft: { text: '', images: [] }, ...over }) as SessionTab

test('an idle tab with an empty draft closes without asking', () => {
  expect(closeWarning(tab({}))).toBeNull()
  expect(closeWarning(tab({ draft: { text: '  \n', images: [] } }))).toBeNull()
})

test('an unsent message or image is said to be discarded', () => {
  expect(closeWarning(tab({ draft: { text: 'salut', images: [] } }))).toContain('sera abandonné')
  expect(closeWarning(tab({ draft: { text: '', images: [{ mediaType: 'image/png', base64: 'A' }] } }))).toContain('sera abandonné')
})

test('a running tab warns about the stop, and the draft too when it has one', () => {
  expect(closeWarning(tab({ state: 'running' }))).toContain("l'arrête")
  const both = closeWarning(tab({ state: 'waiting', draft: { text: 'x', images: [] } }))
  expect(both).toContain("l'arrête")
  expect(both).toContain('abandonné')
})
