import { describe, expect, it } from 'vitest'
import { bannerText } from '../../src/renderer/update/updateText'

// Local-time dates, so the expectations hold in any time zone.
const at = (d: number, h: number, m: number): number => new Date(2026, 10, d, h, m).getTime()

describe('bannerText', () => {
  it('says nothing when no update is waiting', () => {
    expect(bannerText({ phase: 'none' }, at(7, 9, 0))).toBeNull()
  })

  it('gives the time of the restart when it falls on the same day', () => {
    const s = { phase: 'ready', version: '1.2.0', deadline: at(7, 9, 5) } as const
    expect(bannerText(s, at(7, 8, 0))).toBe('Nouvelle version 1.2.0 prête. Redémarrage obligatoire à 09:05.')
  })

  it('says demain when the restart falls on the next day', () => {
    const s = { phase: 'ready', version: '1.2.0', deadline: at(8, 17, 30) } as const
    expect(bannerText(s, at(7, 17, 30))).toBe('Nouvelle version 1.2.0 prête. Redémarrage obligatoire demain à 17:30.')
  })

  it('counts down in m:ss during the warning', () => {
    const restartAt = at(7, 12, 0)
    const s = { phase: 'warning', version: '1.2.0', restartAt } as const
    expect(bannerText(s, restartAt - 65_000)).toContain('dans 1:05')
    expect(bannerText(s, restartAt - 65_000)).toBe(
      'Canopy redémarre dans 1:05 pour installer la version 1.2.0. Tes fichiers non enregistrés et brouillons seront conservés.')
  })

  it('stops at 0:00 once the moment has passed', () => {
    const restartAt = at(7, 12, 0)
    expect(bannerText({ phase: 'warning', version: '1.2.0', restartAt }, restartAt + 5_000)).toContain('dans 0:00')
  })
})
