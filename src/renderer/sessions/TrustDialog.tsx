import type { RepoConfig } from '../../shared/api'
import { basename } from '../store'
import { useSessions } from './sessionStore'

const SECTIONS: { key: keyof RepoConfig; label: string }[] = [
  { key: 'hooks', label: 'Hooks' },
  { key: 'mcpServers', label: 'Serveurs MCP' },
  { key: 'allowRules', label: "Règles d'autorisation" },
  { key: 'apiKeyHelper', label: 'apiKeyHelper' },
  { key: 'statusLine', label: 'statusLine' },
  { key: 'env', label: "Variables d'environnement" }
]

/** Shown before the first session in a repo: a session loads what the repo declares. */
export function TrustDialog(): React.JSX.Element | null {
  const prompt = useSessions((s) => s.trustPrompt)
  if (!prompt) return null
  const { trust, answer } = prompt
  const declared = SECTIONS.filter((s) => trust[s.key].length > 0)
  return (
    <div className="overlay">
      <div className="dialog trust" role="alertdialog" aria-modal="true" aria-label="Faire confiance à ce dépôt ?"
        onKeyDown={(e) => { if (e.key === 'Escape') answer(false) }}>
        <h2>Faire confiance à ce dépôt ?</h2>
        <p className="risk">
          Une session Claude charge le contenu de ce dépôt. Ce qu'il déclare peut exécuter du code sur ta machine,
          avec tes droits. N'accepte que si tu fais confiance à sa provenance.
        </p>
        {declared.length === 0
          ? <p className="plain">Ce dépôt ne déclare ni hook, ni serveur MCP, ni règle d'autorisation.</p>
          : declared.map((s) => (
            <section key={s.key} data-testid={`trust-${s.key}`}>
              <h3>{s.label}</h3>
              <ul className="mono">{trust[s.key].map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          ))}
        <p className="plain">
          Ses commandes, skills, agents et plugins seront aussi chargés. Cette liste vient du worktree principal :
          une autre branche peut déclarer autre chose.
        </p>
        <p className="plain">Si tu refuses, aucune session ne démarre. Le code et le terminal restent utilisables.</p>
        <div className="actions">
          <button type="button" className="secondary" autoFocus onClick={() => answer(false)}>Refuser</button>
          <button type="button" className="primary" onClick={() => answer(true)}>Faire confiance</button>
        </div>
      </div>
    </div>
  )
}
