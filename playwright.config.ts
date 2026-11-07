import { defineConfig } from '@playwright/test'

// The app runs off screen, out of the Dock, without taking the focus. CANOPY_HIDE_WINDOW=0 shows it.
process.env.CANOPY_HIDE_WINDOW ??= '1'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' }
})
