import { expect, test } from 'vitest'
import { accountView, initials } from '../../src/renderer/shell/accountView'

test('initials come from the part before the @, split on . _ -', () => {
  expect(initials('ada.lovelace@example.test')).toBe('AL')
  expect(initials('grace_brewster-hopper@example.test')).toBe('GB')
  expect(initials('linus@example.test')).toBe('LI')
  expect(initials('x@example.test')).toBe('X')
  expect(initials('')).toBe('?')
})

test('a login shows the email, then subscription and organization', () => {
  expect(accountView({ method: 'login', email: 'ada.lovelace@example.test', organization: 'Mon org', subscription: 'Claude Max' }))
    .toEqual({ initials: 'AL', title: 'ada.lovelace@example.test', line1: 'ada.lovelace@example.test', line2: 'Claude Max · Mon org' })
  expect(accountView({ method: 'login', email: 'a.b@example.test' }).line2).toBe('')
})

test('the other states', () => {
  expect(accountView({ method: 'apiKey' })).toMatchObject({ line1: 'Clé API', line2: 'Sessions facturées à l\'usage' })
  expect(accountView({ method: 'none' })).toMatchObject({ line1: 'Non connecté', line2: 'Lance claude auth login' })
  expect(accountView({ method: 'unknown' })).toMatchObject({ line1: 'Compte inconnu' })
})
