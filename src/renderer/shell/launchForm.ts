import type { CanopyConfig } from '../../shared/api'

/** A service row as typed. An empty `portEnv` stands for `PORT`. */
export interface ServiceRow { name: string; command: string; portEnv: string }
/** The « Tester la PR » settings as edited: setup commands one per line. */
export interface LaunchForm { setup: string; services: ServiceRow[] }

const DEFAULT_PORT_ENV = 'PORT'
export const EMPTY_ROW: ServiceRow = { name: '', command: '', portEnv: '' }

export function toForm(config: CanopyConfig | null): LaunchForm {
  if (config === null) return { setup: '', services: [{ ...EMPTY_ROW }] }
  return {
    setup: config.setup.join('\n'),
    services: config.services.map((s) => ({ name: s.name, command: s.command, portEnv: s.portEnv === DEFAULT_PORT_ENV ? '' : s.portEnv }))
  }
}

/** The config to save. Left unchecked here: the main process applies the rules of `.canopy/config.json` and says what is wrong. */
export function fromForm(form: LaunchForm): CanopyConfig {
  return {
    setup: form.setup.split('\n').map((l) => l.trim()).filter((l) => l !== ''),
    services: form.services
      .map((s) => ({ name: s.name.trim(), command: s.command.trim(), portEnv: s.portEnv.trim() || DEFAULT_PORT_ENV }))
      .filter((s) => s.name !== '' || s.command !== '')
  }
}

/** What to send: null for a form left empty, which goes back to `.canopy/config.json` like the main process does. */
export function toSave(form: LaunchForm): CanopyConfig | null {
  const config = fromForm(form)
  return config.setup.length === 0 && config.services.length === 0 ? null : config
}
