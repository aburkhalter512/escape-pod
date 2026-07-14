import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { APIInteraction } from 'discord-api-types/v10'
import { LocalBackendClient } from './backendClient.js'
import type { DiscordRestClient } from './discord/rest.js'
import { verifyDiscordSignature } from './interactions/verify.js'
import { routeInteraction } from './interactions/router.js'
import { requireBotApiKey } from './auth.js'
import type { PtpClient } from './ptp/client.js'
import { zodValidatorCompiler } from './validation.js'
import { registerOrganizerRoutes } from './routes/organizers.js'
import { registerGuildRoutes } from './routes/guilds.js'
import { registerPodRoutes } from './routes/pods.js'
import { ephemeral } from './commands/helpers.js'
import { createInMemoryPendingStartPodStore, type PendingStartPodStore } from './pendingStartPods.js'

// Everything buildApp needs to construct a fully-wired Fastify instance,
// injected rather than read from process.env directly — this is what
// makes the app testable at all: server.ts is the only caller that reads
// real env vars and constructs real Prisma/Discord/PTP clients; tests
// (see *.integration.test.ts) can call buildApp directly with a real
// Prisma client pointed at a local test database plus fake Discord/PTP
// clients, with no live AWS/Discord credentials and no listening socket
// (Fastify's own `.inject()` drives requests in-process).
export interface BuildAppDeps {
  prisma: PrismaClient
  ptp: PtpClient
  discordRest: DiscordRestClient
  discordPublicKey: string
  botApiKey: string
  tokenEncryptionKey: string
  // Defaults to a fresh in-memory store when omitted — only worth
  // injecting your own if a test needs to seed or inspect pending
  // /start-pod selections directly, which none do today.
  pendingStartPods?: PendingStartPodStore
}

// Pure construction — no `.listen()`, no periodic sweeps, no SIGTERM
// wiring. Those are "this is a live, long-running server" concerns that
// belong in server.ts alongside real env-var/AWS/Discord bootstrapping,
// not in something meant to also be constructed cheaply and repeatedly
// inside tests.
export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { prisma, ptp, discordRest, discordPublicKey, botApiKey, tokenEncryptionKey } = deps
  const pendingStartPods = deps.pendingStartPods ?? createInMemoryPendingStartPodStore()

  // Fastify's default is logger: false — silent on every request/response/
  // error, which made a live "this command timed out" report undiagnosable
  // (nothing in CloudWatch beyond the startup line). pino's default JSON
  // output is fine for CloudWatch — greppable, structured.
  const app = Fastify({ logger: true })
  app.setValidatorCompiler(zodValidatorCompiler)

  // The one catch-all for the whole HTTP surface (routes/*.ts) — those
  // route handlers only ever branch on a service's returned Result for
  // expected outcomes (see services/errors.ts), never try/catch. Anything
  // that still throws here is genuinely unexpected (a real bug, a Prisma
  // outage), so this logs it and returns a generic 500 rather than leaking
  // internals. Mirrors the same shape the /interactions handler below
  // already uses for the Discord surface.
  //
  // Fastify's own schema validation (zodValidatorCompiler, validation.ts)
  // also routes its failures through this same handler, tagged with
  // error.code === 'FST_ERR_VALIDATION' and a 400 statusCode — those are
  // well-formed client errors, not the "something actually broke" case the
  // rest of this handler exists for, so they're passed straight through
  // rather than collapsed to a 500. (Checking error.code rather than the
  // more commonly-referenced error.validation: Fastify's wrapValidationError
  // only sets .validation when the schema compiler returns a plain object;
  // zodValidatorCompiler returns the ZodError itself, which is already an
  // Error instance, so Fastify takes its other branch — sets statusCode/code
  // but never sets .validation. Caught by src/app.integration.test.ts's real
  // Fastify + real validator wiring — the narrower per-route unit tests in
  // routes/*.test.ts build their own bare Fastify() instance and never
  // register this handler at all, so they couldn't have caught this.)
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.code === 'FST_ERR_VALIDATION') {
      return reply.code(error.statusCode ?? 400).send({ error: error.message })
    }
    request.log.error({ err: error }, 'unhandled error')
    reply.code(500).send({ error: 'Internal server error' })
  })

  const backendDeps = { prisma, ptp, tokenEncryptionKey, logger: app.log }
  const backend = new LocalBackendClient(backendDeps)

  // Signature verification needs the exact raw request body, so capture it
  // before Fastify's default JSON parsing discards it (INTEGRATIONS.md §7.1).
  // Applies globally — the bearer-protected routes below still get a parsed
  // JSON body as usual, just also get an unused rawBody alongside it.
  // Fastify's own types can't narrow `body` to `string` from `{ parseAs:
  // 'string' }` alone (its generic + conditional-type constraint isn't
  // inferred backward from the literal) — a runtime guard gets the same
  // narrowing without an unchecked cast, and is correct even if that ever
  // changes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (typeof body !== 'string') {
      done(new Error('Expected a string body'), undefined)
      return
    }

    request.rawBody = body
    try {
      done(null, JSON.parse(body))
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // Outside every scope below — infra health probes and Discord's webhook
  // both need to reach these without the bearer API key. Fastify's addHook
  // only applies within the plugin scope it's registered in, not globally,
  // so this separation (not registering these inside the app.register(...)
  // block below) is what actually keeps them unauthenticated — a route-level
  // preHandler override does not skip a hook added at a parent scope.
  app.get('/healthz', async () => ({ ok: true }))

  app.post('/interactions', async (request, reply) => {
    const isValid = await verifyDiscordSignature(request, reply, discordPublicKey)
    if (!isValid) return // verifyDiscordSignature already sent the 401

    const interaction = request.body as APIInteraction
    try {
      const response = await routeInteraction(interaction, { backend, discordRest, pendingStartPods })
      return reply.send(response)
    } catch (err) {
      // An uncaught throw here would otherwise become a raw 500 — not a
      // valid APIInteractionResponse body, so Discord's client just shows
      // "This interaction failed" with nothing else to go on. Logging the
      // real error and still returning a well-formed (ephemeral) response
      // keeps that failure diagnosable from CloudWatch instead of only
      // visible as a generic client-side error.
      request.log.error({ err, interactionType: interaction.type }, 'interaction handling failed')
      return reply.send(ephemeral('Something went wrong handling that. Please try again.'))
    }
  })

  // The internal HTTP API — nothing calls this externally anymore now that
  // Discord interaction handlers call services/* directly in-process, but
  // it's kept as a bearer-protected debug/admin surface (curl-able with
  // BOT_API_KEY) and a seam for any future caller. See routes/*.ts.
  await app.register(async (instance) => {
    instance.addHook('preHandler', requireBotApiKey(botApiKey))

    registerOrganizerRoutes(instance, { prisma, ptp, tokenEncryptionKey })
    registerGuildRoutes(instance, { prisma })
    registerPodRoutes(instance, backendDeps)
  })

  return app
}
