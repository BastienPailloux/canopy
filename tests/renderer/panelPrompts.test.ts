import { expect, test } from 'vitest'
import { linearIdOf, prPrompt, rebasePrompt } from '../../src/renderer/sessions/panelPrompts'

test('the PR sentence, without and with a target branch', () => {
  expect(prPrompt()).toBe('Crée une PR pour cette branche.')
  expect(prPrompt('feat/parent')).toBe('Crée une PR pour cette branche, avec `feat/parent` comme branche cible.')
})

test('the rebase sentence names the comparison ref', () => {
  expect(rebasePrompt('origin/main')).toBe('Rebase cette branche sur `origin/main` et résous les conflits.')
  expect(rebasePrompt('develop')).toBe('Rebase cette branche sur `develop` et résous les conflits.')
})

test('a Linear id is asked in the PR title', () => {
  expect(prPrompt(undefined, 'ENG-482')).toBe('Crée une PR pour cette branche. Mets ENG-482 dans le titre de la PR.')
  expect(prPrompt('feat/p', 'ENG-1')).toBe('Crée une PR pour cette branche, avec `feat/p` comme branche cible. Mets ENG-1 dans le titre de la PR.')
})

test('linearIdOf finds the issue linked to a branch', () => {
  const links = { 'ENG-482': { branch: 'feat/eng-482-x' } }
  expect(linearIdOf(links, 'feat/eng-482-x')).toBe('ENG-482')
  expect(linearIdOf(links, 'feat/other')).toBeUndefined()
})
