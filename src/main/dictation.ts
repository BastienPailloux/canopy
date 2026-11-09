/**
 * Opens macOS dictation on the focused field, as « Édition › Démarrer la dictée » would. The text lands in the field;
 * nothing is sent.
 */
export function startDictation(send: (action: string) => void): void {
  send('startDictation:')
}
