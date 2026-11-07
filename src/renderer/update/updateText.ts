import type { UpdateState } from '../../shared/update'

const two = (n: number): string => String(n).padStart(2, '0')

const clock = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}`

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Seconds left as m:ss, never below 0:00. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${two(s % 60)}`
}

/** The banner sentence for the update state at `now`, or null when there is nothing to announce. */
export function bannerText(s: UpdateState, now: number): string | null {
  if (s.phase === 'none') return null
  if (s.phase === 'ready') {
    const at = new Date(s.deadline)
    const when = sameDay(at, new Date(now)) ? `à ${clock(at)}` : `demain à ${clock(at)}`
    return `Nouvelle version ${s.version} prête. Redémarrage obligatoire ${when}.`
  }
  return `Canopy redémarre dans ${countdown(s.restartAt - now)} pour installer la version ${s.version}. Tes fichiers non enregistrés et brouillons seront conservés.`
}
