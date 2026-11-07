import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MAX_BUFFER_CHARS, TerminalManager, type PtyProcess, type SpawnPty } from '../../../src/main/terminal/TerminalManager'

class FakePty implements PtyProcess {
  written: string[] = []
  size = { cols: 0, rows: 0 }
  killed = false
  private dataCb: (d: string) => void = () => undefined
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => undefined
  onData(cb: (d: string) => void): void { this.dataCb = cb }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb }
  write(d: string): void { this.written.push(d) }
  resize(cols: number, rows: number): void { this.size = { cols, rows } }
  signals: (string | undefined)[] = []
  stubborn = false
  kill(signal?: string): void {
    this.signals.push(signal)
    if (this.stubborn && signal === undefined) return
    this.killed = true
    this.exitCb({ exitCode: 0, signal: 1 })
  }
  emit(d: string): void { this.dataCb(d) }
  end(exitCode: number): void { this.exitCb({ exitCode }) }
}

let dir: string
let ptys: FakePty[]
let calls: Parameters<SpawnPty>[]
let manager: TerminalManager
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canopy-term-'))
  ptys = []
  calls = []
  manager = new TerminalManager({
    spawn: (...args) => { calls.push(args); const p = new FakePty(); ptys.push(p); return p },
    env: () => ({ PATH: '/bin', SHELL: '/bin/zsh', HOME: '/h' })
  })
})
afterEach(async () => {
  manager.disposeAll()
  await rm(dir, { recursive: true, force: true })
})

test('create spawns the login shell in cwd with the env and the reserved port', () => {
  manager.create(dir, { command: 'npm run dev', env: { PORT: '4100' } })
  const [file, args, options] = calls[0]
  expect(file).toBe('/bin/zsh')
  expect(args).toEqual(['-ilc', 'npm run dev'])
  expect(options.cwd).toBe(dir)
  expect(options.env).toMatchObject({ PATH: '/bin', PORT: '4100' })
  expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
})

test('without a command it is an interactive login shell', () => {
  manager.create(dir)
  expect(calls[0][1]).toEqual(['-il'])
})

test('data is forwarded, written and resized to the process', () => {
  const id = manager.create(dir)
  const seen: unknown[] = []
  manager.on('data', (e) => seen.push(e))
  ptys[0].emit('abc')
  manager.write(id, 'ls\r')
  manager.resize(id, 100, 30)
  expect(seen).toEqual([{ id, data: 'abc', end: 3 }])
  expect(ptys[0].written).toEqual(['ls\r'])
  expect(ptys[0].size).toEqual({ cols: 100, rows: 30 })
})

test('buffer keeps the last 2000 lines', () => {
  const id = manager.create(dir)
  for (let i = 0; i < 2500; i++) ptys[0].emit(`line ${i}\r\n`)
  const lines = manager.buffer(id).split('\n').filter((l) => l !== '')
  expect(lines).toHaveLength(2000)
  expect(lines[0]).toBe('line 500\r')
  expect(lines.at(-1)).toBe('line 2499\r')
})

test('snapshot tells how much was written so far', () => {
  const id = manager.create(dir)
  ptys[0].emit('hello')
  expect(manager.snapshot(id)).toEqual({ data: 'hello', end: 5 })
})

test('exit is emitted once and the terminal stays listed as ended', () => {
  const id = manager.create(dir, { label: 'web' })
  const exits: unknown[] = []
  manager.on('exit', (e) => exits.push(e))
  ptys[0].end(3)
  ptys[0].end(4)
  expect(exits).toEqual([{ id, exitCode: 3 }])
  expect(manager.list(dir)).toEqual([expect.objectContaining({ id, label: 'web', running: false, exitCode: 3 })])
  manager.write(id, 'ignored')
  expect(ptys[0].written).toEqual([])
})

test('kill ends a running terminal, remove forgets it', () => {
  const id = manager.create(dir)
  manager.kill(id)
  expect(ptys[0].killed).toBe(true)
  expect(manager.list(dir)[0].running).toBe(false)
  manager.remove(id)
  expect(manager.list(dir)).toEqual([])
})

test('a process that ignores the hangup is killed after a grace period', () => {
  vi.useFakeTimers()
  try {
    const id = manager.create(dir)
    ptys[0].stubborn = true
    manager.kill(id)
    expect(manager.list(dir)[0].running).toBe(true)
    vi.advanceTimersByTime(2100)
    expect(ptys[0].signals).toEqual([undefined, 'SIGKILL'])
    expect(manager.list(dir)[0].running).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

test('list is per worktree', async () => {
  await mkdir(join(dir, 'other'))
  manager.create(dir)
  manager.create(join(dir, 'other'), { label: 'x' })
  expect(manager.list(dir)).toHaveLength(1)
})

test('a missing cwd gives a readable error and spawns nothing', async () => {
  const gone = join(dir, 'gone')
  expect(() => manager.create(gone)).toThrow(/introuvable/)
  expect(calls).toHaveLength(0)
  expect(manager.list(gone)).toEqual([])
})

test('a spawn failure gives a readable error', () => {
  const failing = new TerminalManager({ spawn: () => { throw new Error('posix_spawnp failed') }, env: () => ({}) })
  expect(() => failing.create(dir)).toThrow(/posix_spawnp failed/)
})

test('a process that dies while being written to does not crash', () => {
  const id = manager.create(dir)
  ptys[0].write = vi.fn(() => { throw new Error('EIO') })
  expect(() => manager.write(id, 'x')).not.toThrow()
})

test('disposeAll kills every running terminal', () => {
  manager.create(dir)
  manager.create(dir)
  manager.disposeAll()
  expect(ptys.every((p) => p.killed)).toBe(true)
})

test('a process ended by a signal reports a non-zero code, whatever exitCode says', () => {
  const id = manager.create(dir)
  const exits: unknown[] = []
  manager.on('exit', (e) => exits.push(e))
  manager.kill(id) // the fake, like node-pty, reports { exitCode: 0, signal: 1 }
  expect(exits).toEqual([{ id, exitCode: 129 }])
  expect(manager.list(dir)[0]).toMatchObject({ running: false, exitCode: 129 })
})

test('a normal exit keeps its own code', () => {
  const id = manager.create(dir)
  ptys[0].end(0)
  expect(manager.list(dir)[0].exitCode).toBe(0)
  expect(id).toBeTruthy()
})

test('disposeAll kills a process that ignores the hangup at once, since the app is quitting', () => {
  manager.create(dir)
  ptys[0].stubborn = true
  manager.disposeAll()
  expect(ptys[0].signals).toEqual([undefined, 'SIGKILL'])
})

test('notice writes a line the terminal shows and its buffer keeps', () => {
  const id = manager.create(dir)
  const seen: string[] = []
  manager.on('data', (e) => seen.push(e.data))
  manager.notice(id, 'port pris')
  expect(seen.join('')).toContain('port pris')
  expect(manager.buffer(id)).toContain('port pris')
})

test('output without newlines is capped too, keeping the end and the running count', () => {
  const id = manager.create(dir)
  const chunk = 'x'.repeat(MAX_BUFFER_CHARS / 2)
  for (let i = 0; i < 3; i++) ptys[0].emit(chunk)
  ptys[0].emit('la fin')
  const { data, end } = manager.snapshot(id)
  expect(data.length).toBeLessThanOrEqual(MAX_BUFFER_CHARS)
  expect(data.endsWith('la fin')).toBe(true)
  expect(end).toBe(chunk.length * 3 + 'la fin'.length)
})
