import type { Recording } from './recording'
import type { UserImage } from './update'

export type CaptureKind = 'screenshot' | 'recording'

/** Payload of the `capture:done` event, for the composer of tab `tabId`. */
export type CaptureResult =
  | { tabId: string; kind: 'screenshot'; image: UserImage }
  /** `explainClicks`: clicks were missing and the user was never told why. */
  | { tabId: string; kind: 'recording'; recording: Recording; explainClicks: boolean }
  | { tabId: string; kind: 'cancelled' }
  | { tabId: string; kind: 'needs-permission' }
  | { tabId: string; kind: 'error'; message: string }
