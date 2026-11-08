import { expect, test } from 'vitest'
import { prPrompt, rebasePrompt } from '../../src/renderer/sessions/panelPrompts'

test('the PR sentence, without and with a target branch', () => {
  expect(prPrompt()).toBe('Crée une PR pour cette branche.')
  expect(prPrompt('feat/parent')).toBe('Crée une PR pour cette branche, avec `feat/parent` comme branche cible.')
})

test('the rebase sentence names the comparison ref', () => {
  expect(rebasePrompt('origin/main')).toBe('Rebase cette branche sur `origin/main` et résous les conflits.')
  expect(rebasePrompt('develop')).toBe('Rebase cette branche sur `develop` et résous les conflits.')
})
