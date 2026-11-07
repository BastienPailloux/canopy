import { useEffect, useState } from 'react'
import type { ClaudeAccount } from '../../shared/types'
import { accountView } from './accountView'

/** Fired once a saved or removed API key changes who is billed. */
export const ACCOUNT_CHANGED = 'canopy:account-changed'

/** The main process caches the read for five minutes: asking again on every focus costs nothing. */
function useAccount(): ClaudeAccount | null {
  const [account, setAccount] = useState<ClaudeAccount | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      window.canopy.claudeAccount().then((a) => { if (live) setAccount(a) }, () => { if (live) setAccount({ method: 'unknown' }) })
    }
    read()
    window.addEventListener('focus', read)
    window.addEventListener(ACCOUNT_CHANGED, read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
      window.removeEventListener(ACCOUNT_CHANGED, read)
    }
  }, [])
  return account
}

/** Who the sessions bill, at the bottom of the sidebar. */
export function AccountFooter(): React.JSX.Element | null {
  const account = useAccount()
  if (!account) return null
  const v = accountView(account)
  return (
    <div className="account" data-testid="account" data-method={account.method}>
      <span className="avatar" aria-hidden="true">{v.initials}</span>
      <span className="account-text">
        <span className="account-line1" title={v.title || undefined} data-testid="account-line1">{v.line1}</span>
        {v.line2 && <span className="account-line2" data-testid="account-line2">{v.line2}</span>}
      </span>
    </div>
  )
}
