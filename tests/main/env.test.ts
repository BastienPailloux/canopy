import { beforeEach, describe, expect, test, vi } from 'vitest'
import { currentEnv, fallbackPath, resetCurrentEnv, startEnv } from '../../src/main/env'

beforeEach(() => {
  process.env.USER ??= 'tester'
})

/** The env a login shell answering `out` resolves to. */
const resolved = (out: string): Promise<NodeJS.ProcessEnv> =>
  new Promise((onResolved) => { startEnv({ onResolved, run: async () => out }) })

test('merges shell env over process.env and keeps USER', async () => {
  const env = await resolved('__CANOPY_ENV_START__\nPATH=/x\n__CANOPY_ENV_END__\n')
  expect(env.PATH).toBe('/x')
  expect(env.USER).toBe(process.env.USER)
})

test('drops ELECTRON_RUN_AS_NODE', async () => {
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const env = await resolved('__CANOPY_ENV_START__\nELECTRON_RUN_AS_NODE=1\nA=b\n__CANOPY_ENV_END__')
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env.A).toBe('b')
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE
  }
})

test('ignores noise before the markers', async () => {
  const env = await resolved('motd FOO=bad\n__CANOPY_ENV_START__\nPATH=/y\n__CANOPY_ENV_END__')
  expect(env.PATH).toBe('/y')
  expect(env.FOO).toBeUndefined()
})

test('a login shell that never answers reports nothing after the timeout', async () => {
  const onResolved = vi.fn()
  startEnv({ onResolved, persistedPath: '/kept', run: () => new Promise<string>(() => undefined), timeoutMs: 20 })
  await new Promise((r) => { setTimeout(r, 60) })
  expect(onResolved).not.toHaveBeenCalled()
  expect(currentEnv().PATH).toBe('/kept')
})

const OUT = (path: string): string => `__CANOPY_ENV_START__\nPATH=${path}\nFOO=bar\n__CANOPY_ENV_END__\n`

describe('startEnv', () => {
  beforeEach(() => resetCurrentEnv())

  test('returns at once, with the persisted PATH, while the login shell is still running', () => {
    const resolved = vi.fn()
    startEnv({ persistedPath: '/persisted/bin', run: () => new Promise<string>(() => undefined), onResolved: resolved })
    expect(currentEnv().PATH).toBe('/persisted/bin')
    expect(currentEnv()).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(resolved).not.toHaveBeenCalled()
  })

  test('without a persisted PATH, uses the fallback', () => {
    startEnv({ home: '/h', exists: (p) => p === '/opt/homebrew/bin', run: () => new Promise<string>(() => undefined), onResolved: vi.fn() })
    expect(currentEnv().PATH?.split(':')).toContain('/opt/homebrew/bin')
  })

  test('the resolved env replaces it for later readers and is reported', async () => {
    const resolved = vi.fn()
    startEnv({ persistedPath: '/persisted/bin', run: async () => OUT('/real/bin'), onResolved: resolved })
    await vi.waitFor(() => expect(resolved).toHaveBeenCalledTimes(1))
    expect(currentEnv().PATH).toBe('/real/bin')
    expect(currentEnv().FOO).toBe('bar')
    expect(resolved.mock.calls[0][0].PATH).toBe('/real/bin')
  })

  test('a failed resolve keeps the startup env and reports nothing', async () => {
    const resolved = vi.fn()
    startEnv({ persistedPath: '/persisted/bin', run: async () => { throw new Error('boom') }, onResolved: resolved })
    await new Promise((r) => setTimeout(r, 20))
    expect(currentEnv().PATH).toBe('/persisted/bin')
    expect(resolved).not.toHaveBeenCalled()
  })
})

describe('fallbackPath', () => {
  const dirs = new Set(['/opt/homebrew/bin', '/h/.nvm/versions/node/v18.2.0/bin', '/h/.nvm/versions/node/v20.11.1/bin', '/h/.nvm/versions/node/v9.0.0/bin', '/h/.volta/bin'])
  const options = { home: '/h', path: '/usr/bin:/bin', exists: (p: string) => dirs.has(p), readdir: () => ['v18.2.0', 'v20.11.1', 'v9.0.0'] }

  test('adds the directories that exist, and only those, to the PATH', () => {
    const parts = fallbackPath(options).split(':')
    expect(parts).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/h/.volta/bin', '/usr/bin', '/bin']))
    expect(parts).not.toContain('/usr/local/bin')
    expect(parts).not.toContain('/h/.pyenv/shims')
  })

  test('takes the highest nvm node version', () => {
    const parts = fallbackPath(options).split(':')
    expect(parts).toContain('/h/.nvm/versions/node/v20.11.1/bin')
    expect(parts).not.toContain('/h/.nvm/versions/node/v18.2.0/bin')
  })

  test('does not repeat a directory already in the PATH', () => {
    const parts = fallbackPath({ ...options, path: '/opt/homebrew/bin:/usr/bin' }).split(':')
    expect(parts.filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1)
  })
})
