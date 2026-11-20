/** swiftc invocation (relative to the repo root) for the click helper, or null when it cannot be built here. */
export function buildClicksCommand(o: { platform: NodeJS.Platform; hasSwiftc: boolean }): { file: string; args: string[] } | null {
  if (o.platform !== 'darwin' || !o.hasSwiftc) return null
  return { file: 'swiftc', args: ['-O', '-target', 'arm64-apple-macos13', 'build/capture/clicks.swift', '-o', 'build/capture/canopy-clicks'] }
}
