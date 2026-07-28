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
    // discord-api-types' ESM build (v10.mjs) internally re-exports from
    // its own CJS build via a plain relative import ("import mod from
    // './v10.js'") — a common dual-package shim that Node's loader
    // interops fine, but @cloudflare/vitest-pool-workers' own module
    // resolution can't (confirmed empirically: this exact import graph
    // bundles and deploys fine via a real `wrangler deploy --dry-run`,
    // it only fails under this local test runtime). Cloudflare's own
    // "known issues" doc names deps.optimizer.ssr as the fix for exactly
    // this shape of problem.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          // The bare package name has no root "." export (only
          // subpaths like ./v10, ./globals) — Vite's optimizer needs
          // the actual subpath(s) actually imported, not the package
          // name alone.
          include: ['discord-api-types/v10'],
        },
      },
    },
  },
})
