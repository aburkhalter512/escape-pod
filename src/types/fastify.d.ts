import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    // Captured by the raw-body content-type parser in server.ts, before
    // Fastify's default JSON parsing discards the original bytes. Discord's
    // signature verification (§7.1) must hash the exact raw request body,
    // not a re-serialized version of the parsed object, so this needs to
    // survive as a real request property rather than a one-off cast.
    rawBody?: string
  }
}
