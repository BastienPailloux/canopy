import { describe, expect, it, vi } from 'vitest'
import { isExternalUrl, openExternalUrl } from '../../src/main/externalLinks'

describe('isExternalUrl', () => {
  it('accepts web and mail links', () => {
    expect(isExternalUrl('https://exemple.test/a')).toBe(true)
    expect(isExternalUrl('http://localhost:3000')).toBe(true)
    expect(isExternalUrl('mailto:a@b.fr')).toBe(true)
  })

  it('refuses everything else', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'vscode://x', 'pas une url', '', 3, null]) {
      expect(isExternalUrl(url)).toBe(false)
    }
  })
})

describe('openExternalUrl', () => {
  it('hands an allowed link to the system', async () => {
    const open = vi.fn(async () => undefined)
    await openExternalUrl('https://exemple.test/', open)
    expect(open).toHaveBeenCalledWith('https://exemple.test/')
  })

  it('rejects another link without opening it', async () => {
    const open = vi.fn(async () => undefined)
    await expect(openExternalUrl('file:///etc/passwd', open)).rejects.toThrow('Lien refusé')
    expect(open).not.toHaveBeenCalled()
  })
})
