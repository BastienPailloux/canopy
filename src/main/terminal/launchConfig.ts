import type { AppStore } from '../appStore'
import { mainWorktreeRoot } from '../git/worktrees'
import { isWorktreeOf, requireTrustedRoot } from '../repoTrust'
import { readConfig, validateConfig, type CanopyConfig } from './config'

/**
 * What « Tester la PR » runs in `cwd`. The repo's setting wins: the user wrote it, so it needs no approval.
 * Otherwise `.canopy/config.json`, only if that exact config is approved, since its commands come with the branch;
 * approval is checked again after the read, as the file may change in between.
 */
export async function launchConfig(store: AppStore, cwd: string): Promise<CanopyConfig> {
  const root = await mainWorktreeRoot(cwd)
  const set = store.launchConfig(root)
  // `cwd`'s own `.git` names its root: only the repo's list says it belongs there.
  if (set !== null && await isWorktreeOf(root, cwd)) return set
  await requireTrustedRoot(store, cwd)
  const config = await readConfig(cwd)
  await requireTrustedRoot(store, cwd)
  return config
}

const MAX_SETTING = 64 * 1024

/**
 * Sets the setting of `cwd`'s repo after the same checks as the file, or removes it with null.
 * An empty one is removed too: kept, it would silently disable the file with nothing to run instead.
 */
export async function saveLaunchConfig(store: AppStore, cwd: string, config: unknown): Promise<void> {
  const clean = config === null ? null : validateConfig(config, 'Réglage')
  // It lands in the app state, read and written whole on every change. Measured once valid: only then is it JSON.
  if (clean !== null && Buffer.byteLength(JSON.stringify(clean)) > MAX_SETTING) throw new Error('Réglage invalide : trop long')
  const empty = clean !== null && clean.setup.length === 0 && clean.services.length === 0
  store.setLaunchConfig(await mainWorktreeRoot(cwd), empty ? null : clean)
}
