import { join } from 'node:path'
import type { McpCaller } from '../../src/main/linear/client'
import { replayLinear, type ReplayOptions } from '../../src/main/linear/replay'

export type FakeLinear = McpCaller & { calls: { name: string; args: unknown }[] }

/** Replays the Linear fixtures (see `replayLinear`) and records every `callTool`. `opts` is read live: set `failWith` later to fail from then on. */
export function fakeLinear(opts: ReplayOptions = {}): FakeLinear {
  opts.fixtures ??= join(__dirname, '../fixtures/linear')
  const replay = replayLinear(opts)
  const calls: FakeLinear['calls'] = []
  return {
    calls,
    listTools: () => replay.listTools(),
    callTool: (name, args) => {
      calls.push({ name, args: structuredClone(args) })
      return replay.callTool(name, args)
    },
    close: () => replay.close(),
  }
}
