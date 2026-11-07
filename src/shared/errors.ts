export const REPO_NOT_TRUSTED = 'REPO_NOT_TRUSTED'

/** Only the message crosses IPC, so the code is the message. */
export class RepoNotTrustedError extends Error {
  constructor() {
    super(REPO_NOT_TRUSTED)
    this.name = 'RepoNotTrustedError'
  }
}

/** Also true for the rejection of an IPC call, whose message Electron prefixes. */
export function isRepoNotTrusted(err: unknown): boolean {
  return err instanceof Error && err.message.includes(REPO_NOT_TRUSTED)
}
