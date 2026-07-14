import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { POD_CAPACITY } from './podConfig.js'
import { createFakePtpClient } from './testUtils/fakePtpClient.js'
import { createFakeDiscordRest } from './testUtils/fakeDiscordRest.js'
import { createIntegrationPrisma, resetDb } from './testUtils/integrationDb.js'
import { fakeJwt, futureExpiry } from './testUtils/integrationBackend.js'

// Real Postgres + a real Fastify app built the exact way server.ts builds
// it in production (via buildApp), driven through Fastify's own
// `.inject()` (in-process HTTP, no listening socket) — proves the actual
// wiring (zod validation, the bearer-auth preHandler hook, route
// registration, the error handler) works end to end, not just that the
// underlying service functions do. Discord/PTP are still faked: this
// suite is about this app's own HTTP/DB plumbing, not third-party APIs.
//
// Every request in this file, including setup, goes through app.inject()
// — the same bearer-protected internal HTTP API a real caller uses — never
// `prisma.*` directly. `prisma` is only ever handed to buildApp as a
// wiring dependency (the same way server.ts wires it), never queried from
// test code.
const BOT_API_KEY = 'test-bot-api-key'
const TOKEN_KEY = '11'.repeat(32)

const prisma = createIntegrationPrisma()
let app: FastifyInstance

beforeEach(async () => {
  await resetDb(prisma)
  app = await buildApp({
    prisma,
    ptp: createFakePtpClient({ validateToken: async () => true }),
    discordRest: createFakeDiscordRest(),
    discordPublicKey: 'unused-in-these-tests',
    botApiKey: BOT_API_KEY,
    tokenEncryptionKey: TOKEN_KEY,
  })
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const authHeaders = { authorization: `Bearer ${BOT_API_KEY}` }

describe('internal pods API, end to end against real Postgres', () => {
  it('rejects requests without the bearer API key', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)

    const unauthed = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: [] },
    })
    expect(unauthed.statusCode).toBe(401)
  })

  it('rejects a malformed body via the real zod validator wiring', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      headers: authHeaders,
      // threshold above the schema's max of 8 — should fail validation
      // before ever reaching podsService.startPod.
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 99, guildIds: [] },
    })
    expect(response.statusCode).toBe(400)
  })

  it('creates a round, resolves its targets from a real subscribed guild, then fires it once signups fill the table', async () => {
    const link = await app.inject({
      method: 'POST',
      url: '/organizers/link',
      headers: authHeaders,
      payload: {
        discordId: 'organizer-1',
        token: fakeJwt({ discord_id: 'organizer-1', username: 'OrganizerOne', exp: futureExpiry() }),
      },
    })
    expect(link.statusCode).toBe(200)

    const subscribe = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      headers: authHeaders,
      payload: { guildId: 'guild-1', installedBy: 'organizer-1', channelId: 'channel-1' },
    })
    expect(subscribe.statusCode).toBe(200)

    const startResponse = await app.inject({
      method: 'POST',
      url: '/pods/start',
      headers: authHeaders,
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: POD_CAPACITY, guildIds: ['guild-1'] },
    })
    expect(startResponse.statusCode).toBe(200)
    const started = startResponse.json() as { podRoundId: string; targets: Array<{ guildId: string; channelId: string }> }
    expect(started.targets).toEqual([{ guildId: 'guild-1', channelId: 'channel-1' }])

    // Sign up one short of capacity — round should still be COLLECTING.
    for (let i = 0; i < POD_CAPACITY - 1; i++) {
      const response = await app.inject({
        method: 'POST',
        url: `/pods/${started.podRoundId}/signup`,
        headers: authHeaders,
        payload: { discordId: `player-${i}`, username: `Player${i}`, sourceGuildId: 'guild-1', action: 'in' },
      })
      expect(response.statusCode).toBe(200)
      expect((response.json() as { full: boolean }).full).toBe(false)
    }

    // ptp.createPod isn't wired up on the fake PTP client (default throws
    // — see createFakePtpClient), so the final signup is expected to fail
    // pod creation but the round still transitions to THRESHOLD_REACHED,
    // proving the real claim runs through the real HTTP route.
    const finalSignup = await app.inject({
      method: 'POST',
      url: `/pods/${started.podRoundId}/signup`,
      headers: authHeaders,
      payload: { discordId: 'player-last', username: 'PlayerLast', sourceGuildId: 'guild-1', action: 'in' },
    })
    expect(finalSignup.statusCode).toBe(200)
    expect((finalSignup.json() as { full: boolean; podCreated: boolean }).podCreated).toBe(false)

    // Proof the round really left COLLECTING (not just that this one
    // request happened to fail pod creation): a further signup is now
    // rejected as "already started," which recordSignup only returns once
    // the round is THRESHOLD_REACHED or POD_CREATED.
    const lateSignup = await app.inject({
      method: 'POST',
      url: `/pods/${started.podRoundId}/signup`,
      headers: authHeaders,
      payload: { discordId: 'player-too-late', username: 'PlayerTooLate', sourceGuildId: 'guild-1', action: 'in' },
    })
    expect(lateSignup.statusCode).toBe(422)
    expect((lateSignup.json() as { error: string }).error).toMatch(/already started/i)
  })
})
