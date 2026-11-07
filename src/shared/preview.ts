const MAX = 200

/** A line of code as a list row: indentation dropped, cut when very long. */
export function preview(text: string): string {
  const t = text.trim()
  return t.length > MAX ? `${t.slice(0, MAX)}…` : t
}
