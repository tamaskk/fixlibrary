import { defineConfig } from '@playwright/test'

// E2E tests launch the built Electron app (out/), so `npm run test:e2e` builds first.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
