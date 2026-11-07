import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'

export interface Trigger {
  kind: 'file' | 'command'
  /** What was typed after the `@` or `/`. */
  query: string
  /** Position of the `@` or `/`. */
  start: number
}

const MAX_RESULTS = 8

/** The `/command` or `@file` token being typed at the caret, if any. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)
  const command = /^\/(\S*)$/.exec(before)
  if (command) return { kind: 'command', query: command[1], start: 0 }
  const file = /(?:^|\s)@(\S*)$/.exec(before)
  if (!file) return null
  return { kind: 'file', query: file[1], start: caret - file[1].length - 1 }
}

/** Stable sort on a rank, dropping what ranks `null`, then capped. */
function ranked<T>(list: T[], rank: (item: T) => number | null, limit: number): T[] {
  return list
    .flatMap((item) => {
      const r = rank(item)
      return r === null ? [] : [{ item, r }]
    })
    .sort((a, b) => a.r - b.r)
    .slice(0, limit)
    .map((x) => x.item)
}

export function filterFiles(files: string[], query: string, limit = MAX_RESULTS): string[] {
  const q = query.toLowerCase()
  return ranked(files, (path) => {
    const lower = path.toLowerCase()
    if (lower.slice(lower.lastIndexOf('/') + 1).includes(q)) return 0
    return lower.includes(q) ? 1 : null
  }, limit)
}

export function filterCommands(commands: SlashCommand[], query: string, limit = MAX_RESULTS): SlashCommand[] {
  const q = query.toLowerCase()
  return ranked(commands, (c) => {
    const lower = c.name.toLowerCase()
    if (lower.startsWith(q)) return 0
    return lower.includes(q) ? 1 : null
  }, limit)
}

/** `text` with the token replaced by `value`, and where the caret goes. */
export function applyCompletion(text: string, caret: number, t: Trigger, value: string): { text: string; caret: number } {
  const rest = text.slice(caret)
  const inserted = /^\s/.test(rest) ? value : `${value} `
  return { text: text.slice(0, t.start) + inserted + rest, caret: t.start + value.length + 1 }
}
