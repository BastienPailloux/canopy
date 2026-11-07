import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/main/**/*.test.ts', 'tests/scripts/**/*.test.ts', 'tests/renderer/**/*.test.{ts,tsx}'],
    testTimeout: 20000
  }
})
