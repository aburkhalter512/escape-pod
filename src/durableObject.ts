import { DurableObject } from 'cloudflare:workers'
import { runMigrations } from './storage/migrate.js'
import { createAppSqlStorage, type AppStorage } from './storage/appSqlStorage.js'

// Single source of truth for this Worker's bindings — worker.ts imports
// this rather than declaring its own copy. Phase 9 adds the 2 public
// vars (DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY) once a second
// Discord Application exists to populate them with.
export interface Env {
  ESCAPE_POD_DO: DurableObjectNamespace<EscapePodDurableObject>
}

// The single, global instance holding this app's entire schema — see the
// migration plan's "singleton DO design" section. This is a deliberate,
// scale-appropriate choice (a handful of guilds, low request volume),
// not an oversight; revisit only if traffic grows by orders of
// magnitude. Phase 3 adds the Hono app hosted inside this class, so
// every request is serialized through this one instance.
export class EscapePodDurableObject extends DurableObject<Env> {
  readonly appStorage: AppStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Blocks the DO from serving any request until migrations finish —
    // see storage/migrate.ts.
    ctx.blockConcurrencyWhile(async () => {
      runMigrations(ctx.storage)
    })
    this.appStorage = createAppSqlStorage(ctx.storage.sql)
  }
}
