import { EscapePodDurableObject, type Env } from './durableObject.js'

// Cloudflare requires the DO class to be exported from the Worker's own
// main script (main = "src/worker.ts" in wrangler.toml).
export { EscapePodDurableObject }

// One singleton DO instance holds this whole app's schema/state (see
// durableObject.ts's Env/class comments) — every request, regardless of
// path, is routed to the same instance by name, then forwarded whole via
// stub.fetch(request). All real routing (including /healthz) happens
// inside the DO's Hono app (honoApp.ts) so it's serialized through that
// one instance rather than answered here in the stateless Worker layer.
function getGlobalStub(env: Env) {
  const id = env.ESCAPE_POD_DO.idFromName('global')
  return env.ESCAPE_POD_DO.get(id)
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Response | Promise<Response> {
    return getGlobalStub(env).fetch(request)
  },
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Phase 7 dispatches the three background jobs here based on
    // event.cron.
  },
} satisfies ExportedHandler<Env>
