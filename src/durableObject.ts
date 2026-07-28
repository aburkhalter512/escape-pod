import { DurableObject } from 'cloudflare:workers'
import { runMigrations } from './storage/migrate.js'
import { createAppSqlStorage, type AppStorage } from './storage/appSqlStorage.js'
import { buildHonoApp } from './honoApp.js'
import { createFetchDiscordRest } from './discord/restWorkers.js'
import { HttpPtpClient } from './ptp/client.js'

// Single source of truth for this Worker's bindings — worker.ts imports
// this rather than declaring its own copy. Same env vars server.ts's
// requireEnv calls read on the AWS side (see server.ts), minus
// BOT_API_KEY/DATABASE_URL (no bearer-protected admin surface or
// separate DB connection string on this platform — see honoApp.ts's own
// comment on why the admin routes aren't ported). DISCORD_PUBLIC_KEY/
// DISCORD_APPLICATION_ID/PTP_BASE_URL are plain [vars]; DISCORD_BOT_TOKEN/
// TOKEN_ENCRYPTION_KEY are `wrangler secret put` secrets — both surface
// identically as plain string properties on env. Phase 9 is what actually
// populates these for a real deployment (a second, throwaway Discord
// Application) — until then, requests that reach code paths using these
// see whatever wrangler.toml/.dev.vars currently provides, or undefined.
export interface Env {
  ESCAPE_POD_DO: DurableObjectNamespace<EscapePodDurableObject>
  DISCORD_PUBLIC_KEY: string
  DISCORD_BOT_TOKEN: string
  DISCORD_APPLICATION_ID: string
  TOKEN_ENCRYPTION_KEY: string
  PTP_BASE_URL: string
}

// The single, global instance holding this app's entire schema — see the
// migration plan's "singleton DO design" section. This is a deliberate,
// scale-appropriate choice (a handful of guilds, low request volume),
// not an oversight; revisit only if traffic grows by orders of
// magnitude.
export class EscapePodDurableObject extends DurableObject<Env> {
  readonly appStorage: AppStorage
  private readonly honoApp: ReturnType<typeof buildHonoApp>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Blocks the DO from serving any request until migrations finish —
    // see storage/migrate.ts.
    ctx.blockConcurrencyWhile(async () => {
      runMigrations(ctx.storage)
    })
    this.appStorage = createAppSqlStorage(ctx.storage.sql)
    this.honoApp = buildHonoApp({
      storage: this.appStorage,
      ptp: new HttpPtpClient({ baseUrl: env.PTP_BASE_URL }),
      discordRest: createFetchDiscordRest({ botToken: env.DISCORD_BOT_TOKEN, botUserId: env.DISCORD_APPLICATION_ID }),
      discordPublicKey: env.DISCORD_PUBLIC_KEY,
      tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
      logger: { error: (obj, msg) => console.error(msg, obj) },
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
}
