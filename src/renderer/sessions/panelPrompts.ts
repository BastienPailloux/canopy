/** The sentences the side panel's actions send to Claude. */

/** `target` is the branch the PR goes to when it is not the default one (a stacked branch's base). */
export const prPrompt = (target?: string, linearId?: string): string => {
  const base = target === undefined ? 'Crée une PR pour cette branche.' : `Crée une PR pour cette branche, avec \`${target}\` comme branche cible.`
  return linearId === undefined ? base : `${base} Mets ${linearId} dans le titre de la PR.`
}

/** The Linear issue launched on `branch`, if any: links are keyed by issue id. */
export function linearIdOf(links: Record<string, { branch: string }>, branch: string): string | undefined {
  return Object.entries(links).find(([, l]) => l.branch === branch)?.[0]
}

/** `ref` is the branch the worktree is compared against, as git names it (`origin/main`). */
export const rebasePrompt = (ref: string): string => `Rebase cette branche sur \`${ref}\` et résous les conflits.`
