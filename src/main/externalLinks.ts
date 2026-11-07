const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:']

export function isExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return ALLOWED_PROTOCOLS.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** Opens a link in the default browser. A session's output chooses these links, so the scheme is checked here. */
export async function openExternalUrl(url: unknown, open: (url: string) => Promise<void>): Promise<void> {
  if (!isExternalUrl(url)) throw new Error('Lien refusé')
  await open(url)
}
