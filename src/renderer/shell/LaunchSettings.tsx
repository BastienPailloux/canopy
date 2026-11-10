import { useEffect, useState } from 'react'
import { EMPTY_ROW, fromForm, toForm, toSave, type LaunchForm, type ServiceRow } from './launchForm'

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e))

const hint = { color: 'var(--fg-3)', fontSize: 12, lineHeight: 1.5 }

/** The Enter key would submit the settings form, which saves the API key. */
const noSubmit = (e: React.KeyboardEvent): void => { if (e.key === 'Enter') e.preventDefault() }

interface ViewProps {
  form: LaunchForm
  /** Whether the repo has a setting saved: it then replaces its file. */
  saved: boolean
  dirty: boolean
  onChange: (form: LaunchForm) => void
  onSave: () => void
  onReset: () => void
}

export function LaunchSettingsView({ form, saved, dirty, onChange, onSave, onReset }: ViewProps): React.JSX.Element {
  const setRow = (i: number, patch: Partial<ServiceRow>): void =>
    onChange({ ...form, services: form.services.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  return (
    <div className="launch-settings" data-testid="launch-settings">
      <span className="title">Tester la PR</span>
      <span style={hint}>
        {saved
          ? 'Ce réglage remplace .canopy/config.json pour tous les worktrees du dépôt.'
          : 'Aucun réglage : « Tester la PR » utilise .canopy/config.json du dépôt, s’il existe.'}
      </span>
      <label>
        Setup (une commande par ligne)
        <textarea rows={2} value={form.setup} spellCheck={false} data-testid="launch-setup" placeholder="npm ci"
          onChange={(e) => onChange({ ...form, setup: e.target.value })} />
      </label>
      <span className="title">Services</span>
      {form.services.map((s, i) => (
        <div key={i} className="launch-service" data-testid="launch-service">
          <input aria-label="Nom du service" placeholder="web" value={s.name} spellCheck={false} onKeyDown={noSubmit}
            onChange={(e) => setRow(i, { name: e.target.value })} />
          <input aria-label="Commande du service" className="mono" placeholder="npm run dev" value={s.command} spellCheck={false} onKeyDown={noSubmit}
            onChange={(e) => setRow(i, { command: e.target.value })} />
          <input aria-label="Variable du port" placeholder="PORT" value={s.portEnv} spellCheck={false} onKeyDown={noSubmit}
            onChange={(e) => setRow(i, { portEnv: e.target.value.toUpperCase() })} />
          <button type="button" className="secondary" aria-label={`Retirer le service ${s.name}`}
            onClick={() => onChange({ ...form, services: form.services.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <span style={hint}>Chaque service reçoit son port dans PORT, ou dans la variable indiquée (ex. VITE_PORT).</span>
      <div className="launch-actions">
        <button type="button" className="secondary" onClick={() => onChange({ ...form, services: [...form.services, { ...EMPTY_ROW }] })}>Ajouter un service</button>
        {saved && <button type="button" className="secondary" onClick={onReset}>Revenir au fichier</button>}
        <button type="button" className="secondary" disabled={!dirty} onClick={onSave}>Enregistrer le lancement</button>
      </div>
    </div>
  )
}

/** The « Tester la PR » commands of `repo`, set here instead of in `.canopy/config.json`. */
export function LaunchSettings({ repo }: { repo: string }): React.JSX.Element {
  const [saved, setSaved] = useState<LaunchForm | null>(null)
  const [form, setForm] = useState<LaunchForm>(toForm(null))
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The form shows once the setting is read: what was typed before would be overwritten.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let current = true
    setLoaded(false)
    setSaved(null)
    setForm(toForm(null))
    setError(null)
    setNotice(null)
    window.canopy.launchConfig(repo).then(
      (c) => {
        if (!current) return
        if (c !== null) { setSaved(toForm(c)); setForm(toForm(c)) }
        setLoaded(true)
      },
      (e: unknown) => { if (current) setError(errorText(e)) }
    )
    return () => { current = false }
  }, [repo])

  const write = async (config: Parameters<typeof window.canopy.setLaunchConfig>[1], message: string): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      await window.canopy.setLaunchConfig(repo, config)
      const next = config === null ? null : toForm(config)
      setSaved(next)
      setForm(next ?? toForm(null))
      setNotice(message)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const dirty = JSON.stringify(fromForm(form)) !== JSON.stringify(saved === null ? fromForm(toForm(null)) : fromForm(saved))
  return (
    <>
      {loaded && <LaunchSettingsView form={form} saved={saved !== null} dirty={dirty} onChange={(f) => { setForm(f); setNotice(null) }}
        onSave={() => {
          const config = toSave(form)
          void write(config, config === null ? 'Réglage vide retiré : .canopy/config.json s’applique de nouveau.' : 'Lancement enregistré.')
        }}
        onReset={() => void write(null, 'Réglage retiré : .canopy/config.json s’applique de nouveau.')} />}
      {error && <p className="error" role="alert" data-testid="launch-error">{error}</p>}
      {notice && <span role="status" style={{ color: 'var(--add)', fontSize: 12 }}>{notice}</span>}
    </>
  )
}
