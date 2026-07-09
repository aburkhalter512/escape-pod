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

// All required config up front, fail-fast at boot — a missing var is a
// clear crash-loop with a log line, not a silent runtime failure. This
// includes DATABASE_URL even though Prisma would eventually throw on its
// own first query if it were missing: without this explicit check, a
// missing DATABASE_URL would let the container pass /healthz and only fail
// on the first real interaction, a worse failure mode than crash-looping
// at boot.
const discordPublicKey = requireEnv('DISCORD_PUBLIC_KEY')
const discordBotToken = requireEnv('DISCORD_BOT_TOKEN')
const botApiKey = requireEnv('BOT_API_KEY')
const tokenEncryptionKey = requireEnv('TOKEN_ENCRYPTION_KEY')
const ptpBaseUrl = requireEnv('PTP_BASE_URL')
requireEnv('DATABASE_URL')

const prisma = new PrismaClient()
const ptp = new HttpPtpClient({ baseUrl: ptpBaseUrl })
const discordRest = createDiscordRest(discordBotToken)

const app = Fastify()
app.setValidatorCompiler(zodValidatorCompiler)

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
  const response = await routeInteraction(interaction, { backend, discordRest })
  return reply.send(response)
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

const port = Number(process.env.PORT ?? 3000)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`escape-pod listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
