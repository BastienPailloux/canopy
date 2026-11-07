import type { ElectronApplication } from '@playwright/test'

/** Closes the app, answering « Quitter » to the confirmation shown when something runs or is unsaved. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
  })
  await app.close()
}
