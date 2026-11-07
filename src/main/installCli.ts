import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface InstallCliOptions {
  /** The `canopy` script shipped in the app's resources. */
  source: string
  /** Where the link goes, usually `~/.local/bin`. */
  binDir: string
  pathEnv: string
}

export interface InstallCliResult {
  /** `conflict`: something else is named `canopy` there, left untouched. */
  status: 'installed' | 'conflict'
  link: string
  onPath: boolean
}

/** A link this installer made earlier, possibly for another copy of the app. */
const OURS = /\/Canopy\.app\/(?:.+\/)?canopy$/

/** Links `<binDir>/canopy` to the script. Only replaces a link of its own, never a file or an unrelated link. */
export async function installCli(o: InstallCliOptions): Promise<InstallCliResult> {
  const link = join(o.binDir, 'canopy')
  const onPath = o.pathEnv.split(':').some((p) => p !== '' && resolve(p) === resolve(o.binDir))
  await mkdir(o.binDir, { recursive: true })
  const existing = await lstat(link).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (existing) {
    if (!existing.isSymbolicLink() || !OURS.test(resolve(dirname(link), await readlink(link)))) return { status: 'conflict', link, onPath }
    await unlink(link)
  }
  await symlink(o.source, link)
  return { status: 'installed', link, onPath }
}
