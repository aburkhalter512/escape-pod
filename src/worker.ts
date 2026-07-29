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
  // Reaches the same singleton DO a real request would, via a Durable
  // Object RPC call (stub.runScheduledJob(...), not stub.fetch(...)) —
  // see durableObject.ts's runScheduledJob for the actual job dispatch
  // and why this needs to run inside the DO rather than here.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(getGlobalStub(env).runScheduledJob(event.cron))
  },
} satisfies ExportedHandler<Env>
