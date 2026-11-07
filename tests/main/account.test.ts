import { expect, test } from 'vitest'
import { readClaudeAccount, selectAccountRunner } from '../../src/main/account'

const status = (o: Record<string, unknown>): string => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...o })
const read = (run: () => Promise<string>, hasApiKey = false) => readClaudeAccount({ run, hasApiKey })

test('a login gives the email, the organization and the subscription', async () => {
  const out = status({ email: 'ada.lovelace@example.test', orgName: 'Mon org', subscriptionType: 'max' })
  expect(await read(async () => out)).toEqual({ method: 'login', email: 'ada.lovelace@example.test', organization: 'Mon org', subscription: 'Claude Max' })
})

test('a login without organization omits it', async () => {
  const account = await read(async () => status({ email: 'a@example.test', subscriptionType: 'pro' }))
  expect(account).toEqual({ method: 'login', email: 'a@example.test', subscription: 'Claude Pro' })
})

test('a saved API key wins and runs nothing', async () => {
  let called = false
  const account = await read(async () => { called = true; return '' }, true)
  expect(account).toEqual({ method: 'apiKey' })
  expect(called).toBe(false)
})

test('logged out', async () => {
  expect(await read(async () => JSON.stringify({ loggedIn: false }))).toEqual({ method: 'none' })
})

test('garbage output is an unknown account', async () => {
  expect(await read(async () => 'not json')).toEqual({ method: 'unknown' })
  expect(await read(async () => '[1]')).toEqual({ method: 'unknown' })
  expect(await read(async () => '{"email":"x@example.test"}')).toEqual({ method: 'unknown' })
})

test('a failing command is an unknown account, not a crash', async () => {
  expect(await read(() => Promise.reject(new Error('spawn claude ENOENT')))).toEqual({ method: 'unknown' })
})

test('the fake runner is chosen by the environment, never when packaged', async () => {
  const real = async (): Promise<string> => 'real'
  const env = { CANOPY_FAKE_ACCOUNT: '{"loggedIn":true}' }
  expect(await selectAccountRunner(real, { isPackaged: false, env })()).toBe('{"loggedIn":true}')
  expect(selectAccountRunner(real, { isPackaged: true, env })).toBe(real)
  expect(selectAccountRunner(real, { isPackaged: false, env: {} })).toBe(real)
})
