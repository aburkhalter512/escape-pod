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
        // Test-only fixture values for durableObject.ts's Env, layered on
        // top of wrangler.toml (which has none of these yet — Phase 9 is
        // what populates real values via `wrangler secret put` for an
        // actual deployment). DISCORD_PUBLIC_KEY is paired with a fixed
        // Ed25519 keypair (private half lives inline in
        // podConcurrency.workers.test.ts, generated once and hardcoded —
        // not regenerated per test run, since the public half here has to
        // stay in sync with whatever signs a test request). The others
        // are arbitrary — nothing in these tests makes a real network call
        // to Discord or PTP; every outbound fetch() is stubbed.
        miniflare: {
          bindings: {
            DISCORD_PUBLIC_KEY: '3ba1cd757f0342d8c64d37587ae4ead000d086cedcdf799dc81b29c26914737a',
            DISCORD_BOT_TOKEN: 'test-bot-token',
            DISCORD_APPLICATION_ID: 'test-application-id',
            TOKEN_ENCRYPTION_KEY: '00'.repeat(32),
            PTP_BASE_URL: 'https://ptp.test',
          },
        },
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
