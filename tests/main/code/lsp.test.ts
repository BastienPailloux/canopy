import { execFileSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRepo, type TestRepo } from '../../helpers/repo'

// Records each spawned process: the tests count servers, kill them and read how they were started.
const spawned: { child: ChildProcess; command: string; args: readonly string[]; options: SpawnOptions }[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
      const child = actual.spawn(command, args, options)
      // ripgrep comes through here too, for the text fallback.
      if (command === process.execPath) spawned.push({ child, command, args, options })
      return child
    }) as typeof actual.spawn
  }
})

const { LspPool, unpackedPath } = await import('../../../src/main/code/lsp')

const A = 'export function foo(): number {\n  return 1\n}\n'
const B = 'import { foo } from "./a"\n\nexport const total = foo() + foo()\n'
const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022', noEmit: true }, include: ['*.ts'] })

const env = (): Promise<NodeJS.ProcessEnv> => Promise.resolve(process.env)
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Every process of the server's group: the language server and the tsserver it forks. */
const groupOf = (pid: number): string[] => {
  try {
    return execFileSync('ps', ['-A', '-o', 'pgid=,command=']).toString().split('\n')
      .filter((l) => l.trim().startsWith(`${pid} `))
  } catch {
    return []
  }
}
const stopped = (pid: number): Promise<void> => vi.waitFor(() => { expect(groupOf(pid)).toEqual([]) }, { timeout: 5000 })

let repo: TestRepo
let pool: InstanceType<typeof LspPool>

beforeEach(async () => {
  spawned.length = 0
  repo = await createRepo()
  await repo.commit('tsconfig.json', TSCONFIG)
  await repo.commit('a.ts', A)
  await repo.commit('b.ts', B)
  await repo.commit('tool.py', 'def bar():\n    return 1\n\nprint(bar())\n# barbecue\n')
  pool = new LspPool({ env })
})

afterEach(async () => {
  vi.useRealTimers()
  pool.disposeAll()
  await repo.cleanup()
})

describe('definition', () => {
  it('goes from a call to the function, in 1-based lines and columns', async () => {
    const found = await pool.definition(repo.path, 'b.ts', 3, 22)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ path: 'a.ts', line: 1, column: 17, text: 'export function foo(): number {' })
    expect(found[0].fallback).toBeUndefined()
  })

  it('sees what changed on disk since the last call', async () => {
    await pool.definition(repo.path, 'b.ts', 3, 22)
    await writeFile(join(repo.path, 'b.ts'), `// moved\n${B}`)
    await writeFile(join(repo.path, 'a.ts'), `\n\n${A}`)
    // tsserver notices a file it has not opened through its own watcher, a moment later.
    await vi.waitFor(async () => {
      expect((await pool.definition(repo.path, 'b.ts', 4, 22))[0]).toMatchObject({ path: 'a.ts', line: 3 })
    }, { timeout: 5000 })
  })

  it('does not answer from an old copy of a file a previous call opened', async () => {
    await pool.references(repo.path, 'a.ts', 1, 17)
    await writeFile(join(repo.path, 'a.ts'), `\n\n${A}`)
    const found = await pool.definition(repo.path, 'b.ts', 3, 22)
    expect(found[0]).toMatchObject({ path: 'a.ts', line: 3 })
  })

  it('gives a path in node_modules under the worktree as a relative one', async () => {
    await writeFile(join(repo.path, 'c.ts'), 'import { lib } from "dep"\nlib()\n')
    await mkdir(join(repo.path, 'node_modules/dep'), { recursive: true })
    await writeFile(join(repo.path, 'node_modules/dep/index.d.ts'), 'export declare function lib(): void\n')
    await writeFile(join(repo.path, 'node_modules/dep/package.json'), '{"name":"dep","types":"index.d.ts"}')
    const found = await pool.definition(repo.path, 'c.ts', 2, 1)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ path: 'node_modules/dep/index.d.ts', line: 1 })
    expect(found[0].external).toBeUndefined()
  })

  it('marks a definition outside the worktree as external, with its absolute path', async () => {
    await writeFile(join(repo.path, 'c.ts'), 'console.log(1)\n')
    const found = await pool.definition(repo.path, 'c.ts', 1, 1)
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((l) => l.external === true && l.path.startsWith('/') && !l.path.startsWith(repo.path))).toBe(true)
  })
})

describe('references', () => {
  it('lists the callers, and not the declaration', async () => {
    const found = await pool.references(repo.path, 'a.ts', 1, 17)
    expect(found.map((l) => `${l.path}:${l.line}:${l.column}`)).toEqual(['b.ts:1:10', 'b.ts:3:22', 'b.ts:3:30'])
    expect(found[1].text).toBe('export const total = foo() + foo()')
  })
})

describe('symbols', () => {
  it('finds a symbol of the worktree before any file was opened', async () => {
    const found = await pool.symbols(repo.path, 'foo')
    expect(found).toContainEqual(expect.objectContaining({ name: 'foo', path: 'a.ts', line: 1 }))
  })

  it('starts no server where there is nothing to index', async () => {
    const other = await createRepo()
    try {
      await other.commit('tool.py', 'x = 1\n')
      await expect(pool.symbols(other.path, 'x')).resolves.toEqual([])
      expect(spawned).toHaveLength(0)
    } finally {
      await other.cleanup()
    }
  })

  it('rejects with an AbortError when cancelled', async () => {
    const ctl = new AbortController()
    const pending = pool.symbols(repo.path, 'foo', ctl.signal)
    ctl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('servers', () => {
  it('runs one server per worktree, for parallel and later calls', async () => {
    await Promise.all([pool.definition(repo.path, 'b.ts', 3, 22), pool.references(repo.path, 'a.ts', 1, 17)])
    await pool.definition(repo.path, 'b.ts', 3, 30)
    expect(spawned).toHaveLength(1)
  })

  it('stops a server after 10 minutes without a call, and not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await pool.definition(repo.path, 'b.ts', 3, 22)
    const pid = spawned[0].child.pid as number

    vi.advanceTimersByTime(9 * 60_000)
    await pool.definition(repo.path, 'b.ts', 3, 22)
    vi.advanceTimersByTime(9 * 60_000)
    expect(isAlive(pid)).toBe(true)

    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()
    await stopped(pid)

    await pool.definition(repo.path, 'b.ts', 3, 22)
    expect(spawned).toHaveLength(2)
  })

  it('starts again after the server was killed, without an exception', async () => {
    await pool.definition(repo.path, 'b.ts', 3, 22)
    const killed = spawned[0].child
    const exit = new Promise((r) => killed.once('exit', r))
    killed.kill('SIGKILL')
    await exit

    const found = await pool.definition(repo.path, 'b.ts', 3, 22)
    expect(found[0]).toMatchObject({ path: 'a.ts', line: 1 })
    expect(found[0].fallback).toBeUndefined()
    expect(spawned).toHaveLength(2)
    await stopped(killed.pid as number)
  })

  it('release stops the server of that worktree only, tsserver included', async () => {
    const other = await createRepo()
    try {
      await other.commit('tsconfig.json', TSCONFIG)
      await other.commit('a.ts', A)
      await pool.definition(repo.path, 'b.ts', 3, 22)
      await pool.definition(other.path, 'a.ts', 1, 17)
      const [first, second] = spawned.map((s) => s.child.pid as number)
      expect(groupOf(first).length).toBeGreaterThan(1)

      pool.release(repo.path)
      await stopped(first)
      expect(isAlive(second)).toBe(true)

      pool.disposeAll()
      await stopped(second)
    } finally {
      await other.cleanup()
    }
  })

  it('release during the start leaves no server behind', async () => {
    const pending = pool.definition(repo.path, 'b.ts', 3, 22)
    await vi.waitFor(() => { expect(spawned).toHaveLength(1) })
    pool.release(repo.path)
    await pending
    await stopped(spawned[0].child.pid as number)
  })
})

describe('text fallback', () => {
  it('searches the word under the cursor in a file the server does not read', async () => {
    const found = await pool.definition(repo.path, 'tool.py', 4, 8)
    expect(found.map((l) => `${l.path}:${l.line}`)).toEqual(['tool.py:1', 'tool.py:4'])
    expect(found[0]).toMatchObject({ column: 5, text: 'def bar():', fallback: true })
    await expect(pool.references(repo.path, 'tool.py', 1, 7)).resolves.toHaveLength(2)
    expect(spawned).toHaveLength(0)
  })

  it('finds nothing where the cursor is on no word', async () => {
    await expect(pool.definition(repo.path, 'tool.py', 3, 1)).resolves.toEqual([])
  })

  it('takes over when the server does not start', async () => {
    const broken = new LspPool({ env, server: join(repo.path, 'missing.mjs') })
    const found = await broken.definition(repo.path, 'b.ts', 3, 22)
    expect(found.map((l) => l.path)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']))
    expect(found.every((l) => l.fallback === true)).toBe(true)
    await expect(broken.symbols(repo.path, 'foo')).rejects.toThrow()
    broken.disposeAll()
  })

  it('takes over when the server does not answer', async () => {
    const mute = join(repo.path, 'mute.mjs')
    await writeFile(mute, 'setInterval(() => {}, 1000)\n')
    const silent = new LspPool({ env, server: mute, requestTimeoutMs: 200 })
    const found = await silent.references(repo.path, 'a.ts', 1, 17)
    expect(found.every((l) => l.fallback === true)).toBe(true)
    expect(found.length).toBeGreaterThan(0)
    await stopped(spawned[0].child.pid as number)
    silent.disposeAll()
  })
})

describe('an untrusted repository', () => {
  it('runs in Node mode from Canopy\'s own files, with the login env', async () => {
    const withEnv = new LspPool({ env: () => Promise.resolve({ PATH: '/from/login', NODE_OPTIONS: '--require ./evil.js' }) })
    await withEnv.definition(repo.path, 'b.ts', 3, 22)
    const { command, args, options } = spawned[0]
    expect(command).toBe(process.execPath)
    expect(args[0]).toMatch(/node_modules\/typescript-language-server\/lib\/cli\.mjs$/)
    expect(args).toContain('--stdio')
    expect(options.env).toMatchObject({ PATH: '/from/login', ELECTRON_RUN_AS_NODE: '1' })
    expect(options.env?.NODE_OPTIONS).toBeUndefined()
    withEnv.disposeAll()
  })

  it('never loads its TypeScript, its tsserver plugins or typings', async () => {
    const marker = join(repo.path, 'pwned')
    const payload = `require('fs').writeFileSync(${JSON.stringify(marker)}, __filename)\n`
    await mkdir(join(repo.path, 'node_modules/typescript/lib'), { recursive: true })
    await writeFile(join(repo.path, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"9.9.9"}')
    await writeFile(join(repo.path, 'node_modules/typescript/lib/tsserver.js'), payload)
    await mkdir(join(repo.path, 'node_modules/evil-plugin'), { recursive: true })
    await writeFile(join(repo.path, 'node_modules/evil-plugin/index.js'), payload)
    await writeFile(join(repo.path, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { plugins: [{ name: 'evil-plugin' }, { name: './node_modules/evil-plugin' }] },
      typeAcquisition: { enable: true, include: ['lodash'] },
      include: ['*.ts']
    }))

    const found = await pool.definition(repo.path, 'b.ts', 3, 22)

    expect(found[0]).toMatchObject({ path: 'a.ts' })
    expect(found[0].fallback).toBeUndefined()
    expect(existsSync(marker)).toBe(false)
    const group = groupOf(spawned[0].child.pid as number)
    const tsserver = group.find((l) => l.includes('tsserver'))
    expect(tsserver).toMatch(/node_modules\/tsserver-runtime\/lib\/tsserver\.js/)
    expect(tsserver).toContain('--disableAutomaticTypingAcquisition')
    expect(tsserver).not.toContain('--allowLocalPluginLoads')
    expect(group.some((l) => l.includes('typingsInstaller'))).toBe(false)
  })

  it('does not start without Canopy\'s tsserver: the language server would take the repository\'s', async () => {
    const broken = new LspPool({ env, tsserver: join(repo.path, 'missing/tsserver.js') })
    const found = await broken.definition(repo.path, 'b.ts', 3, 22)
    expect(spawned).toHaveLength(0)
    expect(found.every((l) => l.fallback === true)).toBe(true)
    broken.disposeAll()
  })

  it('refuses a path that leaves the worktree', async () => {
    await expect(pool.definition(repo.path, '../outside.ts', 1, 1)).resolves.toEqual([])
    expect(spawned).toHaveLength(0)
  })
})

describe('unpackedPath', () => {
  it('points inside app.asar.unpacked in a packaged app', () => {
    expect(unpackedPath('/Applications/Canopy.app/Contents/Resources/app.asar/node_modules/x/cli.mjs'))
      .toBe('/Applications/Canopy.app/Contents/Resources/app.asar.unpacked/node_modules/x/cli.mjs')
    expect(unpackedPath('/code/canopy/node_modules/x/cli.mjs')).toBe('/code/canopy/node_modules/x/cli.mjs')
  })
})
