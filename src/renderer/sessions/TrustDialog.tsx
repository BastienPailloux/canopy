import { useRef } from 'react'
import type { RepoConfig } from '../../shared/api'
import { useModal } from '../shell/useModal'
import { basename } from '../store'
import { useSessions } from './sessionStore'

const SECTIONS: { key: keyof RepoConfig; label: string }[] = [
  { key: 'setup', label: 'Commandes de setup (terminal)' },
  { key: 'services', label: 'Services (terminal)' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'mcpServers', label: 'Serveurs MCP' },
  { key: 'allowRules', label: "Règles d'autorisation" },
  { key: 'apiKeyHelper', label: 'apiKeyHelper' },
  { key: 'statusLine', label: 'statusLine' },
  { key: 'env', label: "Variables d'environnement" },
  { key: 'settingsKeys', label: 'Clés des fichiers de réglages' }
]

/** Shown before the first session in a repo: a session loads what the repo declares. */
export function TrustDialog(): React.JSX.Element | null {
  const prompt = useSessions((s) => s.trustPrompt)
  return prompt ? <TrustPrompt prompt={prompt} /> : null
}

// The dialog itself takes focus, not a button, so that the Enter of a send answers nothing.
function TrustPrompt({ prompt }: { prompt: NonNullable<ReturnType<typeof useSessions.getState>['trustPrompt']> }): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const { trust, answer } = prompt
  useModal(dialog, () => answer(false))
  const declared = SECTIONS.filter((s) => trust[s.key].length > 0)
  const title = `Faire confiance à ${basename(trust.repo)} ?`
  return (
    <div className="overlay">
      <div className="dialog trust" ref={dialog} tabIndex={-1} role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p className="plain mono" data-testid="trust-repo">{trust.repo}</p>
        <p className="risk">
          Une session Claude charge le contenu de ce dépôt. Ce qu'il déclare peut exécuter du code sur ta machine,
          avec tes droits. N'accepte que si tu fais confiance à sa provenance.
        </p>
        {trust.unknownFiles.length > 0 && (
          <p className="risk" data-testid="trust-unknown">
            Contenu inconnu, ces fichiers n'ont pas pu être lus : <span className="mono">{trust.unknownFiles.join(', ')}</span>
          </p>
        )}
        {declared.length === 0 && trust.unknownFiles.length === 0
          ? <p className="plain">Ce worktree ne déclare ni hook, ni serveur MCP, ni réglage.</p>
          : declared.map((s) => (
            <section key={s.key} data-testid={`trust-${s.key}`}>
              <h3>{s.label}</h3>
              <ul className="mono">{trust[s.key].map((line) => <li key={line}>{line}</li>)}</ul>
            </section>
          ))}
        <p className="plain">
          Ses commandes, skills, agents et plugins seront aussi chargés. Cette liste vient de ce worktree et des serveurs MCP des dossiers au-dessus :
          si sa configuration change, ou si une autre branche en déclare une autre, Canopy te demandera à nouveau.
        </p>
        <p className="plain">Si tu refuses, aucune session ne démarre. Le code et le terminal restent utilisables.</p>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => answer(false)}>Refuser</button>
          <button type="button" className="primary" onClick={() => answer(true)}>Faire confiance</button>
        </div>
      </div>
    </div>
  )
}
