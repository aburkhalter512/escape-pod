import { defineConfig } from 'vitest/config'

// The regular unit-test suite — hand-rolled fakes/stubs only, no real
// Postgres or network I/O. *.integration.test.ts is carved out here and
// picked up instead by vitest.integration.config.ts (npm run
// test:integration), which needs a real local Postgres running first.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
})
