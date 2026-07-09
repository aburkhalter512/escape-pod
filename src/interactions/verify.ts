import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyKey } from 'discord-interactions'

// Discord signs every interaction POST with the app's public key (Ed25519).
// See INTEGRATIONS.md §7.1 — this is what lets us run as a stateless HTTP
// endpoint instead of holding a gateway connection.
export async function verifyDiscordSignature(
  request: FastifyRequest,
  reply: FastifyReply,
  publicKey: string
): Promise<boolean> {
  const signature = request.headers['x-signature-ed25519']
  const timestamp = request.headers['x-signature-timestamp']
  const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody

  if (typeof signature !== 'string' || typeof timestamp !== 'string' || !rawBody) {
    reply.code(401).send({ error: 'Missing signature headers' })
    return false
  }

  const isValid = await verifyKey(rawBody, signature, timestamp, publicKey)
  if (!isValid) {
    reply.code(401).send({ error: 'Invalid request signature' })
    return false
  }

  return true
}
