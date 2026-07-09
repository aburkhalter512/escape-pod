import Fastify from 'fastify'
import type { APIInteraction } from 'discord-api-types/v10'
import { HttpBackendClient } from './backendClient.js'
import { createDiscordRest } from './discord/rest.js'
import { verifyDiscordSignature } from './interactions/verify.js'
import { routeInteraction } from './interactions/router.js'

const publicKey = requireEnv('DISCORD_PUBLIC_KEY')
const backend = new HttpBackendClient({
  baseUrl: requireEnv('BACKEND_URL'),
  apiKey: requireEnv('BACKEND_API_KEY'),
})
const discordRest = createDiscordRest(requireEnv('DISCORD_BOT_TOKEN'))

const app = Fastify()

// Signature verification needs the exact raw request body, so capture it
// before Fastify's default JSON parsing discards it (INTEGRATIONS.md §7.1).
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

app.post('/interactions', async (request, reply) => {
  const isValid = await verifyDiscordSignature(request, reply, publicKey)
  if (!isValid) return // verifyDiscordSignature already sent the 401

  const interaction = request.body as APIInteraction
  const response = await routeInteraction(interaction, { backend, discordRest })
  return reply.send(response)
})

app.get('/healthz', async () => ({ ok: true }))

const port = Number(process.env.PORT ?? 3000)
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`discord-bot listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
