import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ watcher: null as unknown }))
vi.mock('chokidar', () => ({
  default: {
    watch: () => {
      const w = Object.assign(new EventEmitter(), { add: () => undefined, close: async () => undefined })
      fake.watcher = w
      return w
    }
  }
}))

import { watchWorktree } from '../../../src/main/code/files'

describe('watchWorktree errors', () => {
  it('reports a watcher failure instead of swallowing it', () => {
    const errors: string[] = []
    const stop = watchWorktree('/nowhere', () => undefined, undefined, (e) => errors.push(e.message))
    ;(fake.watcher as EventEmitter).emit('error', new Error('EMFILE: too many open files'))
    stop()
    expect(errors).toEqual(['EMFILE: too many open files'])
  })
})
