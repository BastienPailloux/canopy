import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve('src/renderer'),
    // Under « Tester la PR », Canopy reserves a port per worktree in PORT: several worktrees run side by side.
    server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : {},
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    plugins: [react()]
  }
})
