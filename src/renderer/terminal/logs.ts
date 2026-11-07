import { fenceFor } from '../fence'

const MAX_LINES = 200

// CSI sequences, OSC sequences (title, hyperlinks), and two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

/** The line as the screen would show it: a carriage return restarts the line. */
const settleLine = (line: string): string => line.split('\r').filter((part) => part !== '').at(-1) ?? ''

/** A message for Claude with the last lines of a terminal in a code block. */
export function formatLogs(label: string, raw: string): string {
  const lines = raw.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map(settleLine)
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  const last = lines.slice(-MAX_LINES)
  if (last.length === 0) return `Logs de « ${label} » : aucune sortie pour l'instant.`
  const text = last.join('\n')
  const fence = fenceFor(text)
  return `Voici les ${last.length} dernières lignes de « ${label} » :\n\n${fence}\n${text}\n${fence}`
}
