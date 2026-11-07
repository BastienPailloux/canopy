import { execFile } from 'node:child_process'
import type { ClaudeAccount } from '../shared/types'

/** Runs `claude auth status --json` and returns its stdout. */
export type AccountRunner = () => Promise<string>

const TIMEOUT_MS = 10_000

const SUBSCRIPTIONS: Record<string, string> = {
  free: 'Claude Free', pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise'
}

const subscriptionLabel = (type: string): string => SUBSCRIPTIONS[type.toLowerCase()] ?? `Claude ${type}`
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Who the sessions bill. The output is the user's own: it is parsed here and never logged. */
export async function readClaudeAccount(o: { run: AccountRunner; hasApiKey: boolean }): Promise<ClaudeAccount> {
  if (o.hasApiKey) return { method: 'apiKey' }
  let parsed: unknown
  try {
    parsed = JSON.parse(await o.run())
  } catch {
    return { method: 'unknown' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { method: 'unknown' }
  const s = parsed as Record<string, unknown>
  if (s.loggedIn === false) return { method: 'none' }
  if (s.loggedIn !== true) return { method: 'unknown' }
  const email = text(s.email)
  const organization = text(s.orgName)
  const type = text(s.subscriptionType)
  return {
    method: 'login',
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(type ? { subscription: subscriptionLabel(type) } : {})
  }
}

/** The real runner: the binary sessions use, else `claude` from the env. A non-zero exit that still printed JSON counts. */
export function claudeAuthRunner(o: { executable: () => string | undefined; env: () => NodeJS.ProcessEnv }): AccountRunner {
  return () =>
    new Promise((resolve, reject) => {
      let command: string | undefined
      try {
        command = o.executable()
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      execFile(command ?? 'claude', ['auth', 'status', '--json'], { env: o.env(), timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err && !stdout) reject(err)
        else resolve(stdout)
      })
    })
}

/** The real runner, unless a test gave a canned output. A packaged app ignores that request. */
export function selectAccountRunner(real: AccountRunner, o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): AccountRunner {
  const canned = o.isPackaged ? undefined : o.env.CANOPY_FAKE_ACCOUNT
  return canned ? () => Promise.resolve(canned) : real
}
