import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

// Runs *.workers.test.ts files inside real workerd, with real Durable
// Object bindings (via wrangler.toml) — higher fidelity than mocking,
// used specifically for anything that needs to prove real DO SQLite/Web
// Crypto/Cron Trigger behavior rather than just exercising TypeScript
// logic against a fake. Everything else (services/*.test.ts etc.) stays
// on the existing plain-Node vitest.config.ts — no reason to pay for a
// workerd runtime just to test business logic against a fake.
export default defineWorkersConfig({
  test: {
    include: ['src/**/*.workers.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
})
