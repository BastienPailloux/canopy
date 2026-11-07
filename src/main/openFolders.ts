import { isAbsolute } from 'node:path'

export interface OpenFolders {
  /** A folder asked for from outside. Waits while the page is not ready, is delivered at once afterwards. */
  push(path: string): void
  /** The folder waiting at launch, if any. The page calls it once it listens: it is ready from then on. */
  take(): string | null
  /** The page is gone or about to load again: the next folders wait for it. */
  reset(): void
}

/** Holds the folders macOS hands over (`open -a Canopy <dir>`, hence `canopy .`) until the page can act on them. The last one wins. */
export function createOpenFolders(deliver: (path: string) => void): OpenFolders {
  let ready = false
  let waiting: string | null = null
  return {
    push(path) {
      if (!isAbsolute(path)) return
      if (ready) deliver(path)
      else waiting = path
    },
    take() {
      ready = true
      const path = waiting
      waiting = null
      return path
    },
    reset() {
      ready = false
    }
  }
}
