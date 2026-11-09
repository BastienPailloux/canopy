import type { TranscriptItem } from './transcript'

/** A rendered row's place in the list, in px from its top. */
export interface RowSpan { index: number; start: number; end: number }

/**
 * The user message to keep pinned above the conversation: the last one sent before what shows at the top,
 * once it has left the view, so a long reply never hides what was asked.
 */
export function pinnedUserIndex(items: TranscriptItem[], rows: RowSpan[], scrollTop: number): number | undefined {
  const top = rows.filter((r) => r.end > scrollTop).sort((a, b) => a.start - b.start)[0]
  if (!top) return undefined
  // A message fully in view needs no copy above it, and the one before it no longer matters.
  if (items[top.index]?.kind === 'user' && top.start >= scrollTop) return undefined
  for (let i = top.index; i >= 0; i--) {
    if (items[i].kind === 'user') return i
  }
  return undefined
}

/** What the pinned copy shows: the text sent, else what was attached, so it never shows blank. */
export function pinnedLabel(item: Extract<TranscriptItem, { kind: 'user' }>): string {
  if (item.text.trim()) return item.text
  const n = item.images.length
  const images = n === 0 ? [] : [n === 1 ? 'Image jointe' : `${n} images jointes`]
  const documents = item.documents?.length ? [item.documents.map((d) => d.name).join(', ')] : []
  return [...images, ...documents].join(' · ')
}
