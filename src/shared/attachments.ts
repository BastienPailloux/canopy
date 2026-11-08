const NOTE = /^<attachment-copy>[\s\S]*<\/attachment-copy>$/

/** Tells Claude where the copy of a sent document lies, to read it again once compaction drops it. */
export function attachmentNote(name: string, path: string): string {
  return `<attachment-copy>Copie de la pièce jointe « ${name} », relisible avec Read pendant cette session : ${path}</attachment-copy>`
}

/** The note is for Claude: the transcript hides it. */
export const isAttachmentNote = (text: string): boolean => NOTE.test(text.trim())
