// The contract this middleware actually needs — scoped narrower than
// FastifyRequest/FastifyReply's full generic surface (their `code`/`send`
// methods are generic over route-schema types, which a hand-written test
// stub can't satisfy without falling back to `vi.fn()`). Real Fastify
// request/reply objects satisfy these structurally with no cast; see
// auth.test.ts.
export interface MinimalFastifyRequest {
  headers: { authorization?: string }
}

export interface MinimalFastifyReply {
  code(statusCode: number): MinimalFastifyReply
  send(payload: unknown): MinimalFastifyReply
}

// Only the discord-bot service should be able to call this API — shared
// secret, not PTP's auth at all (this backend is the thing that *holds*
// PTP credentials on organizers' behalf, per §8.5).
export function requireBotApiKey(expectedKey: string) {
  return async (request: MinimalFastifyRequest, reply: MinimalFastifyReply): Promise<void> => {
    const header = request.headers.authorization
    if (header !== `Bearer ${expectedKey}`) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}
