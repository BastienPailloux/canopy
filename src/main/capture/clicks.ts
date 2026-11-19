import type { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'

export type ClickEvent = { t: number; x: number; y: number }
export type ClickLine = { type: 'ready'; trusted: boolean } | ({ type: 'click' } & ClickEvent)

/** Permission the helper checks to report `trusted` (decided by the Task 1 spike; provisional). */
export const CLICK_PERMISSION: 'accessibility' | 'input-monitoring' | 'none' = 'none'

export function parseClickLine(line: string): ClickLine | null {
  let v: unknown
  try { v = JSON.parse(line) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.type === 'ready') return typeof o.trusted === 'boolean' ? { type: 'ready', trusted: o.trusted } : null
  if (o.type === 'click' && typeof o.t === 'number' && typeof o.x === 'number' && typeof o.y === 'number') {
    return { type: 'click', t: o.t, x: o.x, y: o.y }
  }
  return null
}

export interface ClickListener {
  ready: Promise<{ trusted: boolean }>
  /** Closes the helper's stdin (it exits on EOF) and returns the clicks seen so far. */
  stop(): ClickEvent[]
}

export function startClickListener(o: { path: string; spawn: typeof nodeSpawn }): ClickListener {
  const clicks: ClickEvent[] = []
  let resolveReady: (v: { trusted: boolean }) => void = () => {}
  const ready = new Promise<{ trusted: boolean }>((r) => { resolveReady = r })
  // Array args, no shell; stderr ignored so an unread pipe can never block the helper.
  const proc = o.spawn(o.path, ['--check', CLICK_PERMISSION], { stdio: ['pipe', 'pipe', 'ignore'] })
  let buf = ''
  let gotReady = false
  proc.stdout!.setEncoding('utf8')
  proc.stdout!.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = parseClickLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg?.type === 'ready') { gotReady = true; resolveReady({ trusted: msg.trusted }) }
      else if (msg) clicks.push({ t: msg.t, x: msg.x, y: msg.y })
    }
  })
  // A helper that dies before `ready` is reported as untrusted; after `ready` an exit keeps the clicks.
  const failed = (): void => { if (!gotReady) { clicks.length = 0; resolveReady({ trusted: false }) } }
  proc.on('error', failed)
  proc.on('exit', failed)
  // Closing stdin after the helper died raises EPIPE there; unheard, it would crash main.
  proc.stdin?.on('error', () => {})
  return {
    ready,
    stop() {
      try { proc.stdin!.end() } catch { /* already gone */ }
      return clicks.slice()
    }
  }
}

export function clicksHelperPath(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.isPackaged ? join(o.resourcesPath, 'canopy-clicks') : join(o.appPath, 'build', 'capture', 'canopy-clicks')
}
