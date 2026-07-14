import { defineConfig } from 'vitest/config'

// Real Postgres (see testUtils/integrationDb.ts) + real Fastify (see
// app.ts's buildApp), Discord/PTP still faked. Requires `npm run db:up`
// and scripts/test-db-setup.sh to have run first (npm run test:integration
// does both automatically) — not part of the regular `npm test`/CI run.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // All integration test files share one real database — running them
    // across parallel workers would race on the same tables (resetDb
    // truncating out from under another file's in-flight test).
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
