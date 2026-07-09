import { verifyKey } from 'discord-interactions'

// The contract this function actually needs — scoped narrower than
// FastifyRequest/FastifyReply's full generic surface (their `code`/`send`
// methods are generic over route-schema types, which a hand-written test
// stub can't satisfy without falling back to `vi.fn()`). Real Fastify
// request/reply objects satisfy these structurally with no cast; see
// verify.test.ts. Header values are typed `string | string[]` to match
// Node's real IncomingHttpHeaders shape for non-standard header names.
export interface MinimalFastifyRequest {
  headers: {
    [key: string]: string | string[] | undefined
    'x-signature-ed25519'?: string | string[]
    'x-signature-timestamp'?: string | string[]
  }
  rawBody?: string
}

export interface MinimalFastifyReply {
  code(statusCode: number): MinimalFastifyReply
  send(payload: unknown): MinimalFastifyReply
}

// Discord signs every interaction POST with the app's public key (Ed25519).
// See INTEGRATIONS.md §7.1 — this is what lets us run as a stateless HTTP
// endpoint instead of holding a gateway connection.
export async function verifyDiscordSignature(
  request: MinimalFastifyRequest,
  reply: MinimalFastifyReply,
  publicKey: string
): Promise<boolean> {
  const signature = request.headers['x-signature-ed25519']
  const timestamp = request.headers['x-signature-timestamp']
  const rawBody = request.rawBody

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
