import type { Selection } from './Editors'

/** The message "Demander à Claude" sends: the file, the selected lines if any, then the question. */
export function askMessage(path: string, selection: Selection | null, question: string): string {
  if (!selection) return `À propos de \`${path}\` :\n\n${question.trim()}`
  const lines = selection.startLine === selection.endLine ? `ligne ${selection.startLine}` : `lignes ${selection.startLine}–${selection.endLine}`
  // The fence must be longer than any run of backticks inside the selection.
  const longest = Math.max(0, ...(selection.text.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `À propos de \`${path}\` (${lines}) :\n\n${fence}\n${selection.text}\n${fence}\n\n${question.trim()}`
}
