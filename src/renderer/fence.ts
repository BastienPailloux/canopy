/** A code fence longer than any run of backticks in `text`. A loop, not Math.max(...runs): a huge text has too many runs for an argument list. */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) if (run[0].length > longest) longest = run[0].length
  return '`'.repeat(Math.max(3, longest + 1))
}
