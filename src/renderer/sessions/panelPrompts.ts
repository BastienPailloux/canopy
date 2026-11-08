/** The sentences the side panel's actions send to Claude. */

/** `target` is the branch the PR goes to when it is not the default one (a stacked branch's base). */
export const prPrompt = (target?: string): string =>
  target === undefined ? 'Crée une PR pour cette branche.' : `Crée une PR pour cette branche, avec \`${target}\` comme branche cible.`

/** `ref` is the branch the worktree is compared against, as git names it (`origin/main`). */
export const rebasePrompt = (ref: string): string => `Rebase cette branche sur \`${ref}\` et résous les conflits.`
