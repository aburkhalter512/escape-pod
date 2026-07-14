import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import type { APIInteraction } from 'discord-api-types/v10'
import { LocalBackendClient } from './backendClient.js'
import { createDiscordRest } from './discord/rest.js'
import { verifyDiscordSignature } from './interactions/verify.js'
import { routeInteraction } from './interactions/router.js'
import { requireBotApiKey } from './auth.js'
import { HttpPtpClient } from './ptp/client.js'
import { zodValidatorCompiler } from './validation.js'
import { registerOrganizerRoutes } from './routes/organizers.js'
import { registerGuildRoutes } from './routes/guilds.js'
import { registerPodRoutes } from './routes/pods.js'
import { ephemeral } from './commands/helpers.js'
import { expireOverduePodRounds } from './jobs/expirePodRounds.js'
import { createInMemoryPendingStartPodStore } from './pendingStartPods.js'
import { createGracefulShutdown } from './shutdown.js'

// All required config up front, fail-fast at boot — a missing var is a
// clear crash-loop with a log line, not a silent runtime failure. This
// includes DATABASE_URL even though Prisma would eventually throw on its
// own first query if it were missing: without this explicit check, a
// missing DATABASE_URL would let the container pass /healthz and only fail
// on the first real interaction, a worse failure mode than crash-looping
// at boot.
const discordPublicKey = requireEnv('DISCORD_PUBLIC_KEY')
const discordBotToken = requireEnv('DISCORD_BOT_TOKEN')
// A bot's user ID is always identical to its application/client ID — see
// discord/rest.ts's DiscordRestClient.botUserId doc comment for why this
// is threaded in rather than fetched live.
const discordApplicationId = requireEnv('DISCORD_APPLICATION_ID')
const botApiKey = requireEnv('BOT_API_KEY')
const tokenEncryptionKey = requireEnv('TOKEN_ENCRYPTION_KEY')
const ptpBaseUrl = requireEnv('PTP_BASE_URL')
requireEnv('DATABASE_URL')

const prisma = new PrismaClient()
const ptp = new HttpPtpClient({ baseUrl: ptpBaseUrl })
const discordRest = createDiscordRest(discordBotToken, discordApplicationId)
const pendingStartPods = createInMemoryPendingStartPodStore()

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
app.setErrorHandler((error, request, reply) => {
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

// Periodic sweep for /start-pod deadlines (see util/duration.ts,
// jobs/expirePodRounds.ts) — in-process rather than a separate scheduled
// AWS resource, since it needs no state beyond what's already in Postgres
// and reuses the same atomic-claim pattern already proven safe under
// concurrent execution (tasks/001). A 1-minute interval bounds worst-case
// lateness without being noisy; errors are caught and logged rather than
// crashing the sweep loop or the process. The interval itself, and
// tracking whether a sweep is currently in flight, live in shutdown.ts —
// see that module for why: SIGTERM/SIGINT need to stop new ticks and wait
// out any in-flight one before the process (and its DB connection, and any
// in-progress fireRound claim) goes away.
const SWEEP_INTERVAL_MS = 60_000
const gracefulShutdown = createGracefulShutdown({
  app,
  prisma,
  logger: app.log,
  runSweep: () => expireOverduePodRounds(backendDeps, discordRest),
  sweepIntervalMs: SWEEP_INTERVAL_MS,
})
gracefulShutdown.start()

const port = Number(process.env.PORT ?? 3000)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`escape-pod listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

// SIGTERM: what ECS sends on every deploy. SIGINT: Ctrl+C during local
// `npm run dev`. Both get the same graceful drain — see shutdown.ts.
process.on('SIGTERM', () => {
  void gracefulShutdown.shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void gracefulShutdown.shutdown('SIGINT')
})

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
