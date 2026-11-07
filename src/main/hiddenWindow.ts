/** A test run keeps the window off screen and out of the way. A packaged app ignores that request. */
export function hiddenWindow(o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): boolean {
  const asked = o.env.CANOPY_HIDE_WINDOW
  return !o.isPackaged && asked !== undefined && asked !== '' && asked !== '0'
}
