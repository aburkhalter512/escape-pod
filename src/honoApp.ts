import { Hono } from 'hono'
import type { APIInteraction } from 'discord-api-types/v10'
import type { AppStorage } from './storage/appStorage.js'
import type { PtpClient } from './ptp/client.js'
import type { DiscordRestClient } from './discord/rest.js'
import type { Logger } from './services/errors.js'
import type { PendingStartPodStore } from './pendingStartPods.js'
import { LocalBackendClient } from './backendClient.js'
import { verifyDiscordSignatureFromRequest } from './interactions/verify.js'
import { routeInteraction } from './interactions/router.js'
import { ephemeral } from './commands/helpers.js'

// The Worker/DO-side counterpart to app.ts's Fastify buildApp — hosted
// inside durableObject.ts's EscapePodDurableObject.fetch, not in
// worker.ts, so the whole request (not just the final SQL write) is
// serialized through the one DO instance. Kept as a separate file (not
// inlined into durableObject.ts) so a plain-Node *.test.ts can exercise
// route-registration logic against fakes without pulling in any
// Cloudflare-ambient-global-only code.
//
// Deliberately narrower than app.ts's Fastify surface: no bearer-protected
// /organizers, /guilds, /pods admin routes here. app.ts's own comment on
// that registration block says as much already — "nothing calls this
// externally anymore now that Discord interaction handlers call
// services/* directly in-process... kept as a debug/admin surface" — so
// only /healthz and /interactions (the two routes real Discord traffic
// and infra health checks actually need) are ported. Revisit if a real
// caller for the admin surface ever materializes on this platform.
export interface HonoAppDeps {
  storage: AppStorage
  ptp: PtpClient
  discordRest: DiscordRestClient
  discordPublicKey: string
  tokenEncryptionKey: string
  logger: Logger
  // Constructed by durableObject.ts from the DO's own ctx.storage.sql
  // (storage/pendingStartPodsSql.ts), not in-memory like app.ts's
  // equivalent — a DO's in-memory JS state (unlike its storage) gets
  // evicted on routine idle timeout, which would otherwise silently lose
  // a pending /start-pod selection between the "select servers" step and
  // the "Send" confirmation click (see storage/schema.ts's migration 2
  // comment for the fuller story). Accepted as a dep here (not
  // constructed inline) so this file stays free of any direct
  // SqlStorage/Cloudflare-ambient-global reference.
  pendingStartPods: PendingStartPodStore
}

export function buildHonoApp(deps: HonoAppDeps) {
  const backend = new LocalBackendClient({
    storage: deps.storage,
    ptp: deps.ptp,
    tokenEncryptionKey: deps.tokenEncryptionKey,
    logger: deps.logger,
  })
  const pendingStartPods = deps.pendingStartPods

  const app = new Hono()

  app.get('/healthz', (c) => c.text('ok'))

  app.post('/interactions', async (c) => {
    const verifyResult = await verifyDiscordSignatureFromRequest(c.req, deps.discordPublicKey)
    if (!verifyResult.valid) {
      return c.json(verifyResult.body, verifyResult.status)
    }

    // JSON.parse lives inside this try, not just the routeInteraction call
    // below — on the AWS side, Fastify's addContentTypeParser (app.ts)
    // rejects malformed JSON through its own error handler before a route
    // handler ever runs, so app.ts's /interactions handler only ever sees
    // already-valid JSON. Hono has no such upstream layer here, so a
    // validly-signed-but-malformed-JSON body (the Ed25519 signature only
    // proves Discord signed the raw bytes, not that they're valid JSON)
    // needs the same graceful-ephemeral-fallback treatment as any other
    // failure in this handler, not an uncaught throw straight to Hono's
    // default error handling.
    try {
      const interaction = JSON.parse(verifyResult.rawBody) as APIInteraction
      const response = await routeInteraction(interaction, { backend, discordRest: deps.discordRest, pendingStartPods })
      return c.json(response)
    } catch (err) {
      // Same reasoning as app.ts's /interactions handler: an uncaught
      // throw here would otherwise surface to Discord as a raw error
      // response, not a valid APIInteractionResponse body — Discord's
      // client just shows "This interaction failed" with nothing else to
      // go on. Logging the real error (console.error is this platform's
      // equivalent of app.ts's request.log.error — no separate structured
      // logger is wired into the Worker runtime) and still returning a
      // well-formed (ephemeral) response keeps this diagnosable.
      // console.error's default JSON serialization of an Error object
      // drops message/stack (non-enumerable own properties) — pulling
      // them out explicitly is what actually makes `wrangler tail`
      // useful for diagnosing a real failure here, rather than just
      // {code, name}.
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      console.error('interaction handling failed', { message, stack })
      return c.json(ephemeral('Something went wrong handling that. Please try again.'))
    }
  })

  return app
}
