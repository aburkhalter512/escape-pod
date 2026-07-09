import Fastify from 'fastify'
import type { APIInteraction } from 'discord-api-types/v10'
import { BackendClient } from './backendClient.js'
import { createDiscordRest } from './discord/rest.js'
import { verifyDiscordSignature } from './interactions/verify.js'
import { routeInteraction } from './interactions/router.js'

const publicKey = requireEnv('DISCORD_PUBLIC_KEY')
const backend = new BackendClient({
  baseUrl: requireEnv('BACKEND_URL'),
  apiKey: requireEnv('BACKEND_API_KEY'),
})
const discordRest = createDiscordRest(requireEnv('DISCORD_BOT_TOKEN'))

const app = Fastify()

// Signature verification needs the exact raw request body, so capture it
// before Fastify's default JSON parsing discards it (INTEGRATIONS.md §7.1).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  ;(request as unknown as { rawBody: string }).rawBody = body as string
  try {
    done(null, JSON.parse(body as string))
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
