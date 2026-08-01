import { beforeAll, describe, expect, it } from 'vitest'
import type { webcrypto } from 'node:crypto'
import { ComponentType, InteractionType } from 'discord-api-types/v10'
import { buildHonoApp, type HonoAppDeps } from './honoApp.js'
import { createFakeAppSqlStorage } from './testUtils/fakeAppSqlStorage.js'
import { createFakeNiamosClient } from './testUtils/fakeNiamosClient.js'
import { createFakeDiscordRest } from './testUtils/fakeDiscordRest.js'
import { createInMemoryPendingStartPodStore } from './pendingStartPods.js'

// Plain-Node coverage of the Worker/DO-side route registration and
// dispatch logic (mocked backend deps, no real DO/workerd) — the
// real-DO-instance round trip is covered separately by
// worker.workers.test.ts. Web Crypto (crypto.subtle) is a real global in
// Node 19+, so the same real-Ed25519-signature approach as
// interactions/verify.test.ts works here unmodified.
let publicKeyHex: string
let privateKey: webcrypto.CryptoKey

async function sign(timestamp: string, body: string): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body)
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message)
  return Buffer.from(signature).toString('hex')
}

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
  privateKey = keyPair.privateKey
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  publicKeyHex = Buffer.from(rawPublicKey).toString('hex')
})

function buildDeps(overrides: Partial<HonoAppDeps> = {}): HonoAppDeps {
  return {
    storage: createFakeAppSqlStorage(),
    niamos: createFakeNiamosClient(),
    discordRest: createFakeDiscordRest(),
    discordPublicKey: publicKeyHex,
    tokenEncryptionKey: '00'.repeat(32),
    logger: { error: () => {} },
    pendingStartPods: createInMemoryPendingStartPodStore(),
    ...overrides,
  }
}

async function signedRawInteractionsRequest(body: string): Promise<Request> {
  const timestamp = '1700000000'
  const signature = await sign(timestamp, body)
  return new Request('https://example.com/interactions', {
    method: 'POST',
    headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp, 'content-type': 'application/json' },
    body,
  })
}

async function signedInteractionsRequest(bodyObj: unknown): Promise<Request> {
  return signedRawInteractionsRequest(JSON.stringify(bodyObj))
}

// The interaction shape interactions/components.ts's handleModalSubmit
// expects for the /connect-niamos token-submission modal (custom_id
// 'connect-niamos:submit', a 'niamos-token' text input) — reused by both
// tests below that need a real interaction reaching
// backend.linkNiamosToken. guild_id is required (this is now a
// guild-scoped link, not a per-organizer one).
function connectNiamosModalSubmit(token: string) {
  return {
    type: InteractionType.ModalSubmit,
    data: {
      custom_id: 'connect-niamos:submit',
      components: [
        {
          type: ComponentType.ActionRow,
          components: [{ type: ComponentType.TextInput, custom_id: 'niamos-token', value: token }],
        },
      ],
    },
    guild_id: 'guild-1',
    member: { user: { id: 'user-1', username: 'PlayerOne' } },
  }
}

describe('buildHonoApp', () => {
  it('GET /healthz returns ok without touching signature verification', async () => {
    const app = buildHonoApp(buildDeps())

    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  describe('POST /interactions', () => {
    it('answers a correctly signed Ping with Pong', async () => {
      const app = buildHonoApp(buildDeps())

      const response = await app.request(await signedInteractionsRequest({ type: InteractionType.Ping }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ type: 1 })
    })

    it('rejects a request with no signature headers with 401, never reaching routeInteraction', async () => {
      const app = buildHonoApp(buildDeps())

      const response = await app.request('/interactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: InteractionType.Ping }),
      })

      expect(response.status).toBe(401)
    })

    it('rejects a request signed with the wrong key with 401', async () => {
      const app = buildHonoApp(buildDeps({ discordPublicKey: 'a'.repeat(64) }))

      const response = await app.request(await signedInteractionsRequest({ type: InteractionType.Ping }))

      expect(response.status).toBe(401)
    })

    it('returns a well-formed ephemeral response instead of crashing on a validly-signed but malformed-JSON body', async () => {
      // The Ed25519 signature only proves Discord signed these exact raw
      // bytes, not that they're valid JSON — unlike app.ts's Fastify side,
      // which rejects malformed JSON in its content-type parser before a
      // route handler ever runs, this route's JSON.parse has to be inside
      // its own try/catch to get the same graceful fallback (a real gap
      // caught in review, not obvious from the type signatures alone).
      const app = buildHonoApp(buildDeps())

      const response = await app.request(await signedRawInteractionsRequest('not valid json {'))

      expect(response.status).toBe(200)
      const body = (await response.json()) as { data?: { content?: string } }
      expect(body.data?.content).toBe('Something went wrong handling that. Please try again.')
    })

    it('dispatches a real ModalSubmit interaction all the way to the backend and storage', async () => {
      const token = 'nms_a_real_token'
      const linkTokenCalls: unknown[] = []
      const app = buildHonoApp(
        buildDeps({
          niamos: createFakeNiamosClient({ whoami: async () => ({ displayName: 'PlayerOne' }) }),
          storage: createFakeAppSqlStorage({
            guildNiamosToken: {
              linkToken: async (args) => {
                linkTokenCalls.push(args)
                return {
                  guildId: 'guild-1',
                  encryptedToken: 'enc',
                  linkedByDiscordId: 'user-1',
                  linkedAt: new Date('2026-01-01'),
                  displayName: 'PlayerOne',
                }
              },
            },
          }),
        })
      )

      const response = await app.request(await signedInteractionsRequest(connectNiamosModalSubmit(token)))

      expect(response.status).toBe(200)
      expect(linkTokenCalls).toHaveLength(1)
      const body = (await response.json()) as { data?: { content?: string } }
      expect(body.data?.content).toContain('PlayerOne')
    })

    it('returns a well-formed ephemeral response instead of crashing when the backend throws', async () => {
      const token = 'nms_a_real_token'
      const app = buildHonoApp(
        buildDeps({
          niamos: createFakeNiamosClient({
            whoami: async () => {
              throw new Error('boom')
            },
          }),
        })
      )

      const response = await app.request(await signedInteractionsRequest(connectNiamosModalSubmit(token)))

      expect(response.status).toBe(200)
      const body = (await response.json()) as { data?: { content?: string } }
      expect(body.data?.content).toBe('Something went wrong handling that. Please try again.')
    })
  })
})
