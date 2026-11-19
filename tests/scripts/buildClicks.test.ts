import { describe, expect, it } from 'vitest'
import { buildClicksCommand } from '../../scripts/capture/buildClicks.ts'

describe('buildClicksCommand', () => {
  it('compiles the helper with swiftc for arm64 on macOS', () => {
    expect(buildClicksCommand({ platform: 'darwin', hasSwiftc: true })).toEqual({
      file: 'swiftc',
      args: ['-O', '-target', 'arm64-apple-macos13', 'build/capture/clicks.swift', '-o', 'build/capture/canopy-clicks']
    })
  })

  it('does nothing off macOS or without swiftc', () => {
    expect(buildClicksCommand({ platform: 'linux', hasSwiftc: true })).toBeNull()
    expect(buildClicksCommand({ platform: 'darwin', hasSwiftc: false })).toBeNull()
  })
})
