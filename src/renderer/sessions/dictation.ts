/** The part of a text field dictation needs. */
export interface DictationField {
  value: string
  focus(): void
  setSelectionRange(start: number, end: number): void
}

/**
 * How long macOS takes to learn which field holds the focus. A dictation started before that lands on the previous
 * field and macOS drops it a few dozen milliseconds later (seen at ~80 ms in the DictationIM logs).
 */
export const FOCUS_SETTLE_MS = 250

/**
 * Puts the caret at the end of `el` and opens macOS dictation on it. When `el` does not hold the focus yet, it takes
 * it first and dictation waits for macOS to catch up. Never throws: dictation is a convenience.
 */
export async function dictateInto(
  el: DictationField,
  active: unknown,
  start: () => Promise<void>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  const focused = active === el
  if (!focused) el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
  try {
    if (!focused) await wait(FOCUS_SETTLE_MS)
    await start()
  } catch {
    // Dictation stays optional: the field keeps the focus and typing still works.
  }
}
