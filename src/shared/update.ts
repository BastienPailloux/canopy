/** Notes of one published release, shown in "Nouveautés". */
export interface ReleaseNotes {
  version: string
  date: string
  features: string[]
  fixes: string[]
}

/** Where the update stands: nothing ready, ready with a deadline, or in the last-minute warning before the forced restart. */
export type UpdateState =
  | { phase: 'none' }
  | { phase: 'ready'; version: string; deadline: number }
  | { phase: 'warning'; version: string; restartAt: number }
