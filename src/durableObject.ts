import { DurableObject } from 'cloudflare:workers'
import { runMigrations } from './storage/migrate.js'
import { createAppSqlStorage, type AppStorage } from './storage/appSqlStorage.js'
import { createSqlPendingStartPodStore } from './storage/pendingStartPodsSql.js'
import { buildHonoApp } from './honoApp.js'
import { createFetchDiscordRest } from './discord/restWorkers.js'
import type { DiscordRestClient } from './discord/rest.js'
import { HttpNiamosClient } from './niamos/client.js'
import type { NiamosClient } from './niamos/client.js'
import type { Logger } from './services/errors.js'
import { expireOverduePodRounds } from './jobs/expirePodRounds.js'
import { retryOverdueFailedFires } from './jobs/retryFailedFires.js'

// The one cron expression wrangler.toml's [triggers] declares — matched
// literally against event.cron in scheduled() below. Covers both
// expirePodRounds and retryFailedFires (they already share a 60s
// interval on the AWS side, see server.ts's SWEEP_INTERVAL_MS). There is
// no token-refresh cron anymore — Niamos tokens never expire (unlike
// PTP's), so jobs/refreshTokens.ts was deleted entirely rather than
// adapted.
export const POD_SWEEP_CRON = '*/1 * * * *'

// Single source of truth for this Worker's bindings — worker.ts imports
// this rather than declaring its own copy. Same env vars server.ts's
// requireEnv calls read on the AWS side (see server.ts), minus
// BOT_API_KEY/DATABASE_URL (no bearer-protected admin surface or
// separate DB connection string on this platform — see honoApp.ts's own
// comment on why the admin routes aren't ported). DISCORD_PUBLIC_KEY/
// DISCORD_APPLICATION_ID/NIAMOS_API_BASE_URL/NIAMOS_SHARE_BASE_URL are
// plain [vars]; DISCORD_BOT_TOKEN/TOKEN_ENCRYPTION_KEY are
// `wrangler secret put` secrets — both surface identically as plain
// string properties on env.
export interface Env {
  ESCAPE_POD_DO: DurableObjectNamespace<EscapePodDurableObject>
  DISCORD_PUBLIC_KEY: string
  DISCORD_BOT_TOKEN: string
  DISCORD_APPLICATION_ID: string
  TOKEN_ENCRYPTION_KEY: string
  NIAMOS_API_BASE_URL: string
  NIAMOS_SHARE_BASE_URL: string
}

// The single, global instance holding this app's entire schema — see the
// migration plan's "singleton DO design" section. This is a deliberate,
// scale-appropriate choice (a handful of guilds, low request volume),
// not an oversight; revisit only if traffic grows by orders of
// magnitude.
export class EscapePodDurableObject extends DurableObject<Env> {
  readonly appStorage: AppStorage
  private readonly honoApp: ReturnType<typeof buildHonoApp>
  private readonly niamos: NiamosClient
  private readonly discordRest: DiscordRestClient
  private readonly tokenEncryptionKey: string
  private readonly logger: Logger

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Blocks the DO from serving any request until migrations finish —
    // see storage/migrate.ts.
    ctx.blockConcurrencyWhile(async () => {
      runMigrations(ctx.storage)
    })
    this.appStorage = createAppSqlStorage(ctx.storage.sql)
    this.niamos = new HttpNiamosClient({
      apiBaseUrl: env.NIAMOS_API_BASE_URL,
      shareBaseUrl: env.NIAMOS_SHARE_BASE_URL,
      fetch,
    })
    this.discordRest = createFetchDiscordRest({ botToken: env.DISCORD_BOT_TOKEN, botUserId: env.DISCORD_APPLICATION_ID, fetch })
    this.tokenEncryptionKey = env.TOKEN_ENCRYPTION_KEY
    this.logger = { error: (obj, msg) => console.error(msg, obj) }
    this.honoApp = buildHonoApp({
      storage: this.appStorage,
      niamos: this.niamos,
      discordRest: this.discordRest,
      discordPublicKey: env.DISCORD_PUBLIC_KEY,
      tokenEncryptionKey: this.tokenEncryptionKey,
      logger: this.logger,
      pendingStartPods: createSqlPendingStartPodStore(ctx.storage.sql),
    })
  }

  // worker.ts's stateless fetch handler forwards the *entire* incoming
  // request here via stub.fetch(request) — Cloudflare invokes this method
  // for every such call. Hosting the Hono app inside the DO (constructed
  // once, in the constructor, not per-request) rather than in worker.ts
  // is what serializes each whole request — not just the final SQL write
  // — through this one DO instance, which recordSignup's read-check-write
  // sequence needs for its compare-and-swap correctness to hold under
  // concurrent requests (re-proven for real in Phase 4).
  fetch(request: Request): Response | Promise<Response> {
    return this.honoApp.fetch(request)
  }

  // worker.ts's scheduled() handler forwards each Cron Trigger firing
  // here via stub.runScheduledJob(event.cron) — a Durable Object RPC call
  // (stub methods beyond .fetch() are callable directly, same mechanism
  // that already makes appStorage accessible in appSqlStorage.workers.
  // test.ts's runInDurableObject-based tests). Reaching the jobs this way
  // means a scheduled run is serialized through this one DO instance
  // exactly like a real HTTP request is — no separate always-on process,
  // no shutdown-drain machinery to port (see the migration plan's Phase 7
  // notes on why shutdown.ts's setInterval/SIGTERM handling has no
  // Workers equivalent and isn't needed here).
  async runScheduledJob(cron: string): Promise<void> {
    const jobDeps = { storage: this.appStorage, niamos: this.niamos, tokenEncryptionKey: this.tokenEncryptionKey, logger: this.logger }
    if (cron === POD_SWEEP_CRON) {
      // Run concurrently, not sequentially — retryOverdueFailedFires
      // shouldn't need to wait on expireOverduePodRounds's own
      // Niamos/Discord REST calls to start (they touch disjoint PodRound
      // rows — COLLECTING vs THRESHOLD_REACHED — so there's no ordering
      // dependency between them).
      await Promise.all([expireOverduePodRounds(jobDeps, this.discordRest), retryOverdueFailedFires(jobDeps, this.discordRest)])
      return
    }
    this.logger.error({ cron }, 'runScheduledJob: unrecognized cron expression')
  }
}
