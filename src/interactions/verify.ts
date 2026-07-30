import { verifyKey } from 'discord-interactions'

// Discord signs every interaction POST with the app's public key (Ed25519).
// See INTEGRATIONS.md §7.1 — this is what lets us run as a stateless HTTP
// endpoint instead of holding a gateway connection.
//
// Hono's Context has no mutable reply object to call methods on twice —
// a route handler returns one Response value. So this reports its outcome
// as a plain returned result; honoApp.ts's /interactions route turns a
// failure result into the one Response it returns. Real Hono requests
// (c.req) satisfy this structurally — .header() is sync, .text() is
// async, matching HonoRequest's real shape.
export interface MinimalHonoRequest {
  header(name: string): string | undefined
  text(): Promise<string>
}

export type VerifyDiscordSignatureResult =
  | { valid: true; rawBody: string }
  // Literal 401, not a general `number` — both failure branches below
  // return exactly this, and keeping it literal here (rather than widened)
  // is what lets honoApp.ts's c.json(body, status) call pass status
  // straight through without a cast that could silently mask a future
  // mismatch if a new failure branch is ever added with a different code.
  | { valid: false; status: 401; body: { error: string } }

export async function verifyDiscordSignatureFromRequest(
  request: MinimalHonoRequest,
  publicKey: string
): Promise<VerifyDiscordSignatureResult> {
  const signature = request.header('x-signature-ed25519')
  const timestamp = request.header('x-signature-timestamp')
  const rawBody = await request.text()

  if (!signature || !timestamp || !rawBody) {
    return { valid: false, status: 401, body: { error: 'Missing signature headers' } }
  }

  const isValid = await verifyKey(rawBody, signature, timestamp, publicKey)
  if (!isValid) {
    return { valid: false, status: 401, body: { error: 'Invalid request signature' } }
  }

  return { valid: true, rawBody }
}
