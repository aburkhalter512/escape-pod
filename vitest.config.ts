import { defineConfig } from 'vitest/config'

// The regular unit-test suite — hand-rolled fakes/stubs only, no real
// network I/O. *.workers.test.ts is carved out here and picked up instead
// by vitest.workers.config.ts (npm run test:workers), which needs the
// @cloudflare/vitest-pool-workers runtime (real DO bindings,
// `cloudflare:test`), not plain Node.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/*.workers.test.ts'],
  },
})
