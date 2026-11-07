/** The sentences the side panel's actions send to Claude. */
export const PR_PROMPT = 'Crée une PR pour cette branche.'

/** `ref` is the branch the worktree is compared against, as git names it (`origin/main`). */
export const rebasePrompt = (ref: string): string => `Rebase cette branche sur \`${ref}\` et résous les conflits.`
