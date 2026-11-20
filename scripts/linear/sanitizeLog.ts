/**
 * Replaces C0/C1 control characters (newlines, ANSI escapes…) with spaces, so a message coming
 * from the Linear server or the network cannot forge log lines or drive the terminal.
 */
export function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}
