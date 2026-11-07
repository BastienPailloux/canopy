import { expect, test } from 'vitest'
import { removalWarnings } from '../../src/renderer/shell/removalText'

const NONE = { dirty: 0, unpushed: 0, sessions: 0, terminals: 0 }

test('nothing at stake says nothing', () => {
  expect(removalWarnings(NONE, 'feat/a')).toEqual([])
})

test('uncommitted files are lost', () => {
  expect(removalWarnings({ ...NONE, dirty: 1 }, 'feat/a')).toEqual(['1 fichier non commité sera perdu.'])
  expect(removalWarnings({ ...NONE, dirty: 2 }, 'feat/a')).toEqual(['2 fichiers non commités seront perdus.'])
})

test('unpushed commits stay on the branch: they are not lost', () => {
  const [text] = removalWarnings({ ...NONE, unpushed: 2 }, 'feat/a')
  expect(text).toBe('2 commits non poussés restent sur la branche feat/a, sans être sur le remote.')
  expect(text).not.toContain('perdu')
})

test('live sessions and terminals are stopped', () => {
  expect(removalWarnings({ ...NONE, sessions: 1, terminals: 2 }, 'feat/a')).toEqual(['1 session Claude et 2 terminaux actifs seront arrêtés.'])
  expect(removalWarnings({ ...NONE, sessions: 2 }, 'feat/a')).toEqual(['2 sessions Claude seront arrêtées.'])
  expect(removalWarnings({ ...NONE, terminals: 1 }, 'feat/a')).toEqual(['1 terminal actif sera arrêté.'])
})

test('unsaved buffers and unsent messages are lost', () => {
  expect(removalWarnings(NONE, 'feat/a', { buffers: 2, messages: 1 })).toEqual(['2 fichiers non enregistrés et 1 brouillon de message seront perdus.'])
  expect(removalWarnings(NONE, 'feat/a', { buffers: 1, messages: 0 })).toEqual(['1 fichier non enregistré sera perdu.'])
  expect(removalWarnings(NONE, 'feat/a', { buffers: 0, messages: 2 })).toEqual(['2 brouillons de message seront perdus.'])
})

test('on a detached HEAD, commits on no branch are lost, with a way out', () => {
  const [text] = removalWarnings({ ...NONE, unpushed: 2 }, null)
  expect(text).toBe("2 commits ne sont sur aucune branche et seront perdus. Crée d'abord une branche pour les garder.")
  expect(removalWarnings({ ...NONE, unpushed: 1 }, null)[0]).toContain("1 commit n'est sur aucune branche")
  expect(removalWarnings(NONE, null)).toEqual([])
})
