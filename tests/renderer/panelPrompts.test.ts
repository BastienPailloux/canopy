import { expect, test } from 'vitest'
import { PR_PROMPT, rebasePrompt } from '../../src/renderer/sessions/panelPrompts'

test('the PR sentence', () => {
  expect(PR_PROMPT).toBe('Crée une PR pour cette branche.')
})

test('the rebase sentence names the comparison ref', () => {
  expect(rebasePrompt('origin/main')).toBe('Rebase cette branche sur `origin/main` et résous les conflits.')
  expect(rebasePrompt('develop')).toBe('Rebase cette branche sur `develop` et résous les conflits.')
})
