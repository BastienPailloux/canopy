import chokidar from 'chokidar'
import { relative, sep } from 'node:path'

const DEBOUNCE_MS = 150
const DIR = '.tickets'

/**
 * Calls `onChange` once per burst of changes in `<root>/.tickets` (its direct entries, archive folder included).
 * The folder may not exist yet: the root is watched, and everything but `.tickets` is ignored.
 */
export function watchTickets(root: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const fire = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => { if (!stopped) onChange() }, DEBOUNCE_MS)
  }
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 1,
    ignored: (p) => {
      const rel = relative(root, p)
      if (rel === '') return false
      const [top] = rel.split(sep)
      // Half-written files (tmp then rename) are not worth a refresh.
      return top !== DIR || rel.endsWith('.tmp')
    }
  })
  watcher.on('all', fire)
  // A watcher that fails leaves the list as it is: the next write by the app refreshes it anyway.
  watcher.on('error', () => undefined)
  return () => {
    stopped = true
    clearTimeout(timer)
    void watcher.close()
  }
}
