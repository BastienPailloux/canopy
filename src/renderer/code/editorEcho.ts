/**
 * Tells the editor's own text coming back through React from a real change. React answers late: by then the model
 * holds more, and treating the old text as new would wipe the last keystrokes and throw the cursor to the top.
 */
export function createEchoFilter(): { sent: (text: string) => void; isEcho: (value: string) => boolean } {
  let pending: string[] = []
  return {
    sent(text) { pending.push(text) },
    isEcho(value) {
      const at = pending.lastIndexOf(value)
      pending = at === -1 ? [] : pending.slice(at + 1)
      return at !== -1
    }
  }
}
