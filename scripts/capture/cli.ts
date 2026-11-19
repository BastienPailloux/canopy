import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildClicksCommand } from './buildClicks.ts'

const root = join(import.meta.dirname, '..', '..')

function hasSwiftc(): boolean {
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A stale helper would hide a failed build from the release check.
rmSync(join(root, 'build', 'capture', 'canopy-clicks'), { force: true })

const cmd = buildClicksCommand({ platform: process.platform, hasSwiftc: hasSwiftc() })
if (!cmd) {
  // Never fail an install: screen recordings just lose click markers.
  console.warn('canopy-clicks: swiftc unavailable or not macOS, skipping the click helper build')
} else {
  try {
    execFileSync(cmd.file, cmd.args, { cwd: root, stdio: 'inherit' })
  } catch {
    console.warn('canopy-clicks: build failed, screen recordings will have no click markers')
  }
}
