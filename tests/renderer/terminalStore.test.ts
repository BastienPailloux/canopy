import { beforeEach, expect, it, vi } from 'vitest'
import type { CanopyApi, TerminalInfo } from '../../src/shared/api'

vi.mock('../../src/renderer/terminal/terminalViews', () => ({ disposeView: vi.fn(), noteExit: vi.fn(), writeToView: vi.fn() }))
vi.mock('../../src/renderer/sessions/sessionStore', () => ({ askClaude: vi.fn(), confirmTrust: vi.fn(async () => true) }))

import { closeTerminal, connectTerminals, testPR, useTerminals } from '../../src/renderer/terminal/terminalStore'

const CWD = '/wt'
const setup: TerminalInfo = { id: 'term-1', cwd: CWD, label: 'setup', kind: 'setup', running: true }
const web: TerminalInfo = { id: 'term-2', cwd: CWD, label: 'web', kind: 'service', running: true, port: 4100 }

let handlers: Record<string, (p: unknown) => void>
let api: { runSetup: ReturnType<typeof vi.fn>; runServices: ReturnType<typeof vi.fn> }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  useTerminals.setState({ open: false, terms: {}, active: {}, notices: {} })
  handlers = {}
  api = { runSetup: vi.fn(async () => setup), runServices: vi.fn(async () => [web]) }
  const canopy = {
    ...api,
    listTerminals: vi.fn(async () => Object.values(useTerminals.getState().terms)),
    removeTerminal: vi.fn(async () => undefined),
    on: (event: string, cb: (p: unknown) => void) => { handlers[event] = cb; return () => undefined }
  }
  vi.stubGlobal('window', { canopy: canopy as unknown as CanopyApi })
  connectTerminals()
})

it('does not start the services when the setup was stopped (signal exit, non-zero code)', async () => {
  const run = testPR(CWD)
  await tick()
  handlers['terminal:exit']({ id: 'term-1', exitCode: 129 })
  await run
  expect(api.runServices).not.toHaveBeenCalled()
  expect(useTerminals.getState().notices[CWD]).toContain('129')
})

it('starts the services after a setup that succeeded', async () => {
  const run = testPR(CWD)
  await tick()
  handlers['terminal:exit']({ id: 'term-1', exitCode: 0 })
  await run
  expect(api.runServices).toHaveBeenCalledWith(CWD)
})

it('stops waiting when the setup terminal is closed, and starts nothing', async () => {
  const run = testPR(CWD)
  await tick()
  closeTerminal('term-1')
  await run
  expect(api.runServices).not.toHaveBeenCalled()
  expect(useTerminals.getState().notices[CWD]).toContain('fermé')
})
