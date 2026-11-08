import type { UserContent, UserDocument } from './types'

/** One image of a message, as the composer attaches it. */
export type UserImage = NonNullable<UserContent['images']>[number]

/** What a composer holds. `documents` is absent from drafts stashed before PDFs. */
export interface Draft { text: string; images: UserImage[]; documents?: UserDocument[] }

/** Nothing typed or attached. With `trim`, blank text counts as nothing. */
export const isDraftEmpty = (d: Draft, trim = false): boolean =>
  (trim ? d.text.trim() : d.text) === '' && d.images.length === 0 && !d.documents?.length

/** Notes of one published release, shown in "Nouveautés". */
export interface ReleaseNotes {
  version: string
  date: string
  features: string[]
  fixes: string[]
}

/** An unsaved editor buffer set aside across the restart. `version` is the one the editor last saw. */
export interface StashedBuffer { cwd: string; path: string; text: string; version: string }

/** A session tab set aside across the restart, with the message it was writing. */
export interface StashedTab {
  cwd: string
  sessionId?: string
  title: string
  draft: Draft
  interrupted: boolean
}

/** Work set aside before an update restart. `format` lets a later build refuse what it cannot read. */
export interface Stash { format: 1; buffers: StashedBuffer[]; tabs: StashedTab[] }

/** Where the update stands: nothing ready, ready with a deadline, or in the last-minute warning before the forced restart. */
export type UpdateState =
  | { phase: 'none' }
  | { phase: 'ready'; version: string; deadline: number }
  | { phase: 'warning'; version: string; restartAt: number }
