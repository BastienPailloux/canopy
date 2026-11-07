import type { ClaudeAccount } from '../../shared/types'

export interface AccountView { initials: string; title: string; line1: string; line2: string }

/** Two letters from the part before the @, split on `.`, `_` and `-`. */
export function initials(email: string): string {
  const parts = (email.split('@')[0] ?? '').split(/[._-]+/).filter((p) => p !== '')
  if (parts.length === 0) return '?'
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)
  return letters.toUpperCase()
}

export function accountView(a: ClaudeAccount): AccountView {
  switch (a.method) {
    case 'apiKey': return { initials: 'AP', title: '', line1: 'Clé API', line2: 'Sessions facturées à l\'usage' }
    case 'none': return { initials: '?', title: '', line1: 'Non connecté', line2: 'Lance claude auth login' }
    case 'unknown': return { initials: '?', title: '', line1: 'Compte inconnu', line2: '' }
    case 'login': {
      const line1 = a.email ?? 'Connecté'
      return { initials: a.email ? initials(a.email) : '?', title: a.email ?? '', line1, line2: [a.subscription, a.organization].filter(Boolean).join(' · ') }
    }
  }
}
