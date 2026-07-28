import { Hono } from 'hono'
import { EscapePodDurableObject, type Env } from './durableObject.js'

// Cloudflare requires the DO class to be exported from the Worker's own
// main script (main = "src/worker.ts" in wrangler.toml).
export { EscapePodDurableObject }

const app = new Hono<{ Bindings: Env }>()

// Trivial for now — Phase 3 replaces this with real routes that forward
// the whole request into the singleton DO via stub.fetch(request).
app.get('/healthz', (c) => c.text('ok'))

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Phase 7 dispatches the three background jobs here based on
    // event.cron.
  },
} satisfies ExportedHandler<Env>
