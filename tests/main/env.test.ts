import { beforeEach, expect, test } from 'vitest'
import { loginShellEnv, resetLoginShellEnvCache } from '../../src/main/env'

beforeEach(() => {
  resetLoginShellEnvCache()
  process.env.USER ??= 'tester'
})

test('merges shell env over process.env and keeps USER', async () => {
  const env = await loginShellEnv(async () => '__CANOPY_ENV_START__\nPATH=/x\n__CANOPY_ENV_END__\n')
  expect(env.PATH).toBe('/x')
  expect(env.USER).toBe(process.env.USER)
})

test('drops ELECTRON_RUN_AS_NODE', async () => {
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const env = await loginShellEnv(async () => '__CANOPY_ENV_START__\nELECTRON_RUN_AS_NODE=1\nA=b\n__CANOPY_ENV_END__')
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env.A).toBe('b')
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE
  }
})

test('ignores noise before the markers', async () => {
  const env = await loginShellEnv(async () => 'motd FOO=bad\n__CANOPY_ENV_START__\nPATH=/y\n__CANOPY_ENV_END__')
  expect(env.PATH).toBe('/y')
  expect(env.FOO).toBeUndefined()
})

test('falls back to process.env when the runner fails', async () => {
  const env = await loginShellEnv(async () => { throw new Error('boom') })
  expect(env.PATH).toBe(process.env.PATH)
})

test('caches the result', async () => {
  const first = await loginShellEnv(async () => '__CANOPY_ENV_START__\nA=1\n__CANOPY_ENV_END__')
  const second = await loginShellEnv(async () => '__CANOPY_ENV_START__\nA=2\n__CANOPY_ENV_END__')
  expect(second).toBe(first)
})
