import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import type { Prisma } from '@prisma/client'
import { zodValidatorCompiler } from '../validation.js'
import type { AppPrismaClient } from '../prismaClient.js'
import type { CreatePodParams, PtpClient } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { registerPodRoutes } from './pods.js'

const TOKEN_KEY = '00'.repeat(32) // 32-byte hex key, fine for tests

type PodRoundCreateArgs = Parameters<AppPrismaClient['podRound']['create']>[0]
type PodRoundRow = Awaited<ReturnType<AppPrismaClient['podRound']['create']>>
type PodRoundUpdateArgs = Parameters<AppPrismaClient['podRound']['update']>[0]
type PodRoundUpdateManyArgs = Parameters<AppPrismaClient['podRound']['updateMany']>[0]
type PodRoundWithOrganizer = Prisma.PodRoundGetPayload<{ include: { organizer: true } }>
type GuildSubscriptionFindManyArgs = Parameters<AppPrismaClient['guildSubscription']['findMany']>[0]
type GuildSubscriptionRow = Awaited<ReturnType<AppPrismaClient['guildSubscription']['findMany']>>[number]
type PodRoundTargetFindUniqueArgs = Parameters<AppPrismaClient['podRoundTarget']['findUnique']>[0]
type PodRoundTargetRow = Awaited<ReturnType<AppPrismaClient['podRoundTarget']['update']>>
type PodRoundTargetUpdateArgs = Parameters<AppPrismaClient['podRoundTarget']['update']>[0]
type PodRoundTargetFindManyArgs = Parameters<AppPrismaClient['podRoundTarget']['findMany']>[0]
type PodRoundSignupUpsertArgs = Parameters<AppPrismaClient['podRoundSignup']['upsert']>[0]
type PodRoundSignupRow = Awaited<ReturnType<AppPrismaClient['podRoundSignup']['upsert']>>

function fakePodRoundRow(overrides: Partial<PodRoundRow> = {}): PodRoundRow {
  return {
    id: 'round-1',
    organizerDiscordId: 'organizer-1',
    setCode: 'JTL',
    threshold: 8,
    status: 'COLLECTING',
    scheduledFor: null,
    ptpPodShareId: null,
    originGuildName: null,
    originGuildId: null,
    chatChannelId: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function fakeRoundWithOrganizer(overrides: Partial<PodRoundWithOrganizer> = {}): PodRoundWithOrganizer {
  return {
    ...fakePodRoundRow(),
    organizer: {
      discordId: 'organizer-1',
      username: 'OrganizerOne',
      encryptedToken: encryptToken('a-real-token', TOKEN_KEY),
      expiresAt: new Date(),
      linkedAt: new Date(),
    },
    ...overrides,
  }
}

function fakeGuildSubscriptionRow(overrides: Partial<GuildSubscriptionRow> = {}): GuildSubscriptionRow {
  return {
    guildId: 'g1',
    installedByDiscordId: 'admin-1',
    broadcastChannelId: 'channel-1',
    postingPolicy: 'ALLOWLIST',
    unsubscribedAt: null,
    installedAt: new Date(),
    ...overrides,
  }
}

function fakePodRoundTargetRow(overrides: Partial<PodRoundTargetRow> = {}): PodRoundTargetRow {
  return {
    podRoundId: 'round-1',
    guildId: 'g1',
    channelId: 'channel-1',
    messageId: null,
    approvalStatus: null,
    postedAt: new Date(),
    ...overrides,
  }
}

function fakePodRoundSignupRow(overrides: Partial<PodRoundSignupRow> = {}): PodRoundSignupRow {
  return {
    podRoundId: 'round-1',
    discordId: 'player-1',
    usernameSnapshot: 'PlayerOne',
    sourceGuildId: 'guild-1',
    status: 'IN',
    signedUpAt: new Date(),
    ...overrides,
  }
}

// podRound.findUnique is called both with and without `include: {organizer:
// true}` (see routes/pods.ts), so AppPrismaClient keeps it generic like
// Prisma's own method — real Prisma computes the return shape from the
// args' `include`/`select` at each call site, which a fixed test double
// can't replicate generically. This stub stays genuinely generic (same
// signature as the real method, so it assigns with no cast at the
// interface boundary); the one unavoidable cast is internal, converting
// the test's fixed `impl()` result into "whatever shape T asked for" —
// each test already knows which shape it's simulating.
function stubPodRoundFindUnique<Result>(impl: () => Promise<Result>) {
  const calls: Prisma.PodRoundFindUniqueArgs[] = []
  function findUnique<T extends Prisma.PodRoundFindUniqueArgs>(
    args: Prisma.SelectSubset<T, Prisma.PodRoundFindUniqueArgs>
  ): Promise<Prisma.PodRoundGetPayload<T> | null> {
    calls.push(args)
    return impl() as unknown as Promise<Prisma.PodRoundGetPayload<T> | null>
  }
  findUnique.calls = calls
  return findUnique
}

function buildApp(overrides: { prisma?: FakePrismaOverrides; ptp?: Partial<PtpClient> } = {}) {
  const app = Fastify()
  app.setValidatorCompiler(zodValidatorCompiler)
  const prisma = createFakePrismaClient({
    podRoundTarget: { findMany: stub(async (_args: PodRoundTargetFindManyArgs) => []) },
    guildSubscription: { findMany: stub(async (_args: GuildSubscriptionFindManyArgs) => []) },
    ...overrides.prisma,
  })
  const ptp = createFakePtpClient(overrides.ptp)
  const logger = { error: () => {} }

  registerPodRoutes(app, { prisma, ptp, tokenEncryptionKey: TOKEN_KEY, logger })
  return { app, prisma, ptp }
}

describe('POST /pods/start', () => {
  it("resolves each target guild's broadcast channel and returns it alongside the round id", async () => {
    const create = stub(async (args: PodRoundCreateArgs) => {
      const expected: PodRoundCreateArgs = {
        data: {
          organizerDiscordId: 'organizer-1',
          setCode: 'JTL',
          threshold: 8,
          scheduledFor: undefined,
          originGuildName: undefined,
          originGuildId: undefined,
          targets: {
            create: [
              { guildId: 'g1', channelId: 'channel-1' },
              { guildId: 'g2', channelId: 'channel-2' },
            ],
          },
        },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.create args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const findMany = stub(async (_args: GuildSubscriptionFindManyArgs) => [
      fakeGuildSubscriptionRow({ guildId: 'g1', broadcastChannelId: 'channel-1' }),
      fakeGuildSubscriptionRow({ guildId: 'g2', broadcastChannelId: 'channel-2' }),
    ])
    const { app } = buildApp({ prisma: { podRound: { create }, guildSubscription: { findMany } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['g1', 'g2'] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      podRoundId: 'round-1',
      targets: [{ guildId: 'g1', channelId: 'channel-1' }, { guildId: 'g2', channelId: 'channel-2' }],
    })
  })

  it('silently drops a guildId whose subscription no longer exists rather than failing the whole round', async () => {
    // e.g. a guild unsubscribed between /start-pod's eligibility check and
    // this call — a stale target shouldn't block starting the round.
    const create = stub(async (_args: PodRoundCreateArgs) => fakePodRoundRow())
    const findMany = stub(async (_args: GuildSubscriptionFindManyArgs) => [
      fakeGuildSubscriptionRow({ guildId: 'g1', broadcastChannelId: 'channel-1' }),
    ])
    const { app } = buildApp({ prisma: { podRound: { create }, guildSubscription: { findMany } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['g1', 'g2-gone'] },
    })

    expect(response.json().targets).toEqual([{ guildId: 'g1', channelId: 'channel-1' }])
  })

  it('handles an empty guildIds list without erroring', async () => {
    const create = stub(async (_args: PodRoundCreateArgs) => fakePodRoundRow())
    const { app } = buildApp({ prisma: { podRound: { create } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: { organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: [] },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().targets).toEqual([])
  })

  it('coerces an ISO scheduledFor string into a Date on the create call', async () => {
    const create = stub(async (args: PodRoundCreateArgs) => {
      expect(args.data.scheduledFor).toEqual(new Date('2026-01-01T12:00:00.000Z'))
      return fakePodRoundRow()
    })
    const { app } = buildApp({ prisma: { podRound: { create } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/start',
      payload: {
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        guildIds: [],
        scheduledFor: '2026-01-01T12:00:00.000Z',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(create.calls).toHaveLength(1)
  })

  describe('request validation', () => {
    const validPayload = {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: ['g1'],
    }

    it('rejects a missing required field with 400, before touching prisma', async () => {
      const create = stub(async (_args: PodRoundCreateArgs) => fakePodRoundRow())
      const { app } = buildApp({ prisma: { podRound: { create } } })
      const { guildIds, ...withoutGuildIds } = validPayload
      void guildIds

      const response = await app.inject({ method: 'POST', url: '/pods/start', payload: withoutGuildIds })

      expect(response.statusCode).toBe(400)
      expect(create.calls).toHaveLength(0)
    })

    it.each([1, 9, 0, -1])('rejects a threshold outside the 2-8 range (%i)', async (threshold) => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, threshold },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects a non-integer threshold', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, threshold: 6.5 },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects guildIds that is not an array of strings', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, guildIds: [123, 'g2'] },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects an empty-string setCode', async () => {
      const { app } = buildApp()

      const response = await app.inject({
        method: 'POST',
        url: '/pods/start',
        payload: { ...validPayload, setCode: '' },
      })

      expect(response.statusCode).toBe(400)
    })
  })
})

describe('POST /pods/:id/targets/:guildId/message', () => {
  it('records the messageId on the matching target', async () => {
    const findUnique = stub(async (_args: PodRoundTargetFindUniqueArgs) =>
      fakePodRoundTargetRow({ podRoundId: 'round-1', guildId: 'g1' })
    )
    const update = stub(async (args: PodRoundTargetUpdateArgs) => {
      const expected: PodRoundTargetUpdateArgs = {
        where: { podRoundId_guildId: { podRoundId: 'round-1', guildId: 'g1' } },
        data: { messageId: 'msg-1' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundTargetRow()
    })
    const { app } = buildApp({ prisma: { podRoundTarget: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/targets/g1/message',
      payload: { messageId: 'msg-1' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('returns 404 when there is no target for that round/guild pair', async () => {
    const findUnique = stub(async (_args: PodRoundTargetFindUniqueArgs) => null)
    const update = stub(async (_args: PodRoundTargetUpdateArgs) => fakePodRoundTargetRow())
    const { app } = buildApp({ prisma: { podRoundTarget: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/targets/unknown-guild/message',
      payload: { messageId: 'msg-1' },
    })

    expect(response.statusCode).toBe(404)
    expect(update.calls).toHaveLength(0)
  })

  it('rejects an empty-string messageId with 400 rather than storing it', async () => {
    const findUnique = stub(async (_args: PodRoundTargetFindUniqueArgs) =>
      fakePodRoundTargetRow({ podRoundId: 'round-1', guildId: 'g1' })
    )
    const update = stub(async (_args: PodRoundTargetUpdateArgs) => fakePodRoundTargetRow())
    const { app } = buildApp({ prisma: { podRoundTarget: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/targets/g1/message',
      payload: { messageId: '' },
    })

    expect(response.statusCode).toBe(400)
    expect(update.calls).toHaveLength(0)
  })
})

describe('POST /pods/:id/signup', () => {
  it('returns 404 when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const { app } = buildApp({ prisma: { podRound: { findUnique } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne', sourceGuildId: 'guild-1', action: 'in' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('records the signup and reports the count without creating a pod when below threshold', async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakeRoundWithOrganizer())
    const upsert = stub(async (args: PodRoundSignupUpsertArgs) => {
      const expected: PodRoundSignupUpsertArgs = {
        where: { podRoundId_discordId: { podRoundId: 'round-1', discordId: 'player-1' } },
        create: {
          podRoundId: 'round-1',
          discordId: 'player-1',
          usernameSnapshot: 'PlayerOne',
          sourceGuildId: 'guild-1',
          status: 'IN',
        },
        update: { status: 'IN' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected signup upsert args: ${JSON.stringify(args)}`)
      return fakePodRoundSignupRow()
    })
    // count is derived from this findMany's length, not a separate
    // .count() call.
    const findMany = stub(async (_args: unknown) => [
      fakePodRoundSignupRow({ discordId: 'player-1' }),
      fakePodRoundSignupRow({ discordId: 'player-2' }),
      fakePodRoundSignupRow({ discordId: 'player-3' }),
      fakePodRoundSignupRow({ discordId: 'player-4' }),
      fakePodRoundSignupRow({ discordId: 'player-5' }),
    ])
    const createPod = stub(async (_token: string, _params: CreatePodParams) => {
      throw new Error('createPod should not have been called below threshold')
    })
    const { app } = buildApp({
      prisma: { podRound: { findUnique }, podRoundSignup: { upsert, findMany } },
      ptp: { createPod },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne', sourceGuildId: 'guild-1', action: 'in' },
    })

    expect(response.json()).toEqual({
      count: 5,
      threshold: 8,
      setCode: 'JTL',
      full: false,
      podCreated: false,
      signupDiscordIds: ['player-1', 'player-2', 'player-3', 'player-4', 'player-5'],
      originGuildName: null,
      scheduledFor: null,
      targets: [],
    })
  })

  it('records status: LEFT (not IN) when the action is leave, so it drops out of the threshold count', async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakeRoundWithOrganizer())
    const upsert = stub(async (args: PodRoundSignupUpsertArgs) => {
      const expected: PodRoundSignupUpsertArgs = {
        where: { podRoundId_discordId: { podRoundId: 'round-1', discordId: 'player-1' } },
        create: {
          podRoundId: 'round-1',
          discordId: 'player-1',
          usernameSnapshot: 'PlayerOne',
          sourceGuildId: 'guild-1',
          status: 'LEFT',
        },
        update: { status: 'LEFT' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected signup upsert args: ${JSON.stringify(args)}`)
      return fakePodRoundSignupRow({ status: 'LEFT' })
    })
    // podRoundSignup.findMany already filters `status: 'IN'` in production
    // code (unchanged by this fix) — a player whose upsert just wrote
    // LEFT is excluded from the next findMany query for real, in Postgres.
    // This test proves the write side; the read side is covered by the
    // "below threshold" test above using the same findMany filter.
    const findMany = stub(async (_args: unknown) => [
      fakePodRoundSignupRow({ discordId: 'player-2' }),
      fakePodRoundSignupRow({ discordId: 'player-3' }),
      fakePodRoundSignupRow({ discordId: 'player-4' }),
      fakePodRoundSignupRow({ discordId: 'player-5' }),
    ])
    const { app } = buildApp({ prisma: { podRound: { findUnique }, podRoundSignup: { upsert, findMany } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne', sourceGuildId: 'guild-1', action: 'leave' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ count: 4, full: false })
  })

  it('creates the PTP pod once the signup pushes the count to threshold, and returns every target for cross-guild sync', async () => {
    const round = fakeRoundWithOrganizer()
    const targetRows = [
      fakePodRoundTargetRow({ guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1' }),
      fakePodRoundTargetRow({ guildId: 'g2', channelId: 'channel-2', messageId: null }),
    ]
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const expected: PodRoundUpdateManyArgs = {
        where: { id: 'round-1', status: 'COLLECTING' },
        data: { status: 'THRESHOLD_REACHED' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.updateMany args: ${JSON.stringify(args)}`)
      return { count: 1 }
    })
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'POD_CREATED', ptpPodShareId: 'share-1' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const upsert = stub(async (_args: PodRoundSignupUpsertArgs) => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const eightSignupIds = ['player-1', 'player-2', 'player-3', 'player-4', 'player-5', 'player-6', 'player-7', 'player-8']
    const findManySignups = stub(async (_args: unknown) => eightSignupIds.map((discordId) => fakePodRoundSignupRow({ discordId })))
    const findManyTargets = stub(async (_args: PodRoundTargetFindManyArgs) => targetRows)
    const createPod = stub(async (token: string, params: CreatePodParams) => {
      const validArgs = token === 'a-real-token' && deepEqual(params, { setCode: 'JTL', maxPlayers: 8 })
      if (!validArgs) throw new Error(`unexpected createPod args: ${token} ${JSON.stringify(params)}`)
      return {
        id: 'ptp-pod-1',
        shareId: 'share-1',
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        createdAt: '2026-01-01T00:00:00Z',
      }
    })
    const { app } = buildApp({
      prisma: {
        podRound: { findUnique, update, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
        podRoundTarget: { findMany: findManyTargets },
      },
      ptp: { createPod },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-8', username: 'PlayerEight', sourceGuildId: 'guild-1', action: 'in' },
    })

    expect(response.json()).toEqual({
      count: 8,
      threshold: 8,
      setCode: 'JTL',
      full: true,
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      signupDiscordIds: eightSignupIds,
      originGuildName: null,
      scheduledFor: null,
      targets: targetRows.map((t) => ({ guildId: t.guildId, channelId: t.channelId, messageId: t.messageId })),
    })
  })

  it('only calls PTP once when two signups race to push the round past threshold (tasks/001)', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    // Models Postgres's row-level serialization of the conditional UPDATE
    // this fix relies on: exactly one concurrent caller's
    // `WHERE status = 'COLLECTING'` ever matches, no matter how the two
    // requests interleave — everyone else sees count: 0.
    let claimed = false
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const expected: PodRoundUpdateManyArgs = {
        where: { id: 'round-1', status: 'COLLECTING' },
        data: { status: 'THRESHOLD_REACHED' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.updateMany args: ${JSON.stringify(args)}`)
      if (claimed) return { count: 0 }
      claimed = true
      return { count: 1 }
    })
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'POD_CREATED', ptpPodShareId: 'share-1' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const upsert = stub(async (_args: PodRoundSignupUpsertArgs) => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const findManySignups = stub(async (_args: unknown) =>
      ['player-1', 'player-2', 'player-3', 'player-4', 'player-5', 'player-6', 'player-7', 'player-8'].map((discordId) =>
        fakePodRoundSignupRow({ discordId })
      )
    )
    const createPod = stub(async (_token: string, _params: CreatePodParams) => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))
    const { app } = buildApp({
      prisma: { podRound: { findUnique, update, updateMany }, podRoundSignup: { upsert, findMany: findManySignups } },
      ptp: { createPod },
    })

    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/pods/round-1/signup',
        payload: { discordId: 'player-7', username: 'PlayerSeven', sourceGuildId: 'guild-1', action: 'in' },
      }),
      app.inject({
        method: 'POST',
        url: '/pods/round-1/signup',
        payload: { discordId: 'player-8', username: 'PlayerEight', sourceGuildId: 'guild-1', action: 'in' },
      }),
    ])

    expect(responseA.statusCode).toBe(200)
    expect(responseB.statusCode).toBe(200)
    expect(updateMany.calls).toHaveLength(2)
    expect(createPod.calls).toHaveLength(1)
    // Exactly one request won the claim and actually created the pod —
    // the other still gets a coherent 200 with podCreated: false, not a
    // duplicate pod or an error.
    const podCreatedFlags = [responseA.json().podCreated, responseB.json().podCreated]
    expect(podCreatedFlags.filter(Boolean)).toHaveLength(1)
  })

  it('marks the round THRESHOLD_REACHED (not an error response) when PTP pod creation fails after threshold is hit', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const expected: PodRoundUpdateManyArgs = {
        where: { id: 'round-1', status: 'COLLECTING' },
        data: { status: 'THRESHOLD_REACHED' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.updateMany args: ${JSON.stringify(args)}`)
      return { count: 1 }
    })
    const update = stub(async (_args: PodRoundUpdateArgs) => {
      // The atomic claim (updateMany) already recorded THRESHOLD_REACHED —
      // a failed PTP call shouldn't need a separate update call.
      throw new Error('podRound.update should not have been called')
    })
    const upsert = stub(async (_args: PodRoundSignupUpsertArgs) => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const findManySignups = stub(async (_args: unknown) =>
      ['player-1', 'player-2', 'player-3', 'player-4', 'player-5', 'player-6', 'player-7', 'player-8'].map((discordId) =>
        fakePodRoundSignupRow({ discordId })
      )
    )
    const createPod = stub(async (_token: string, _params: CreatePodParams) => {
      throw new Error('PTP pod creation failed: 401')
    })
    const { app } = buildApp({
      prisma: { podRound: { findUnique, update, updateMany }, podRoundSignup: { upsert, findMany: findManySignups } },
      ptp: { createPod },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-8', username: 'PlayerEight', sourceGuildId: 'guild-1', action: 'in' },
    })

    // The signup itself still succeeds from the player's point of view —
    // only the pod-creation side effect failed. §7.5 step 4's design note:
    // this needs an operator-facing alert, not yet built (see source TODO).
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ full: true, podCreated: false })
    expect(response.json().shareUrl).toBeUndefined()
  })

  it('rejects a signup for a round that already reached POD_CREATED, without touching the signup table or PTP', async () => {
    // e.g. a player clicking a stale RSVP button after the pod already
    // exists — recordSignup now bails out before upserting/counting for
    // any round no longer COLLECTING (see services/pods.test.ts).
    const round = fakeRoundWithOrganizer({ status: 'POD_CREATED' })
    const findUnique = stubPodRoundFindUnique(async () => round)
    const update = stub(async (_args: PodRoundUpdateArgs) => {
      throw new Error('podRound.update should not have been called')
    })
    const upsert = stub(async (_args: PodRoundSignupUpsertArgs) => {
      throw new Error('podRoundSignup.upsert should not have been called')
    })
    const findMany = stub(async (_args: unknown) => {
      throw new Error('podRoundSignup.findMany should not have been called')
    })
    const createPod = stub(async (_token: string, _params: CreatePodParams) => {
      throw new Error('createPod should not have been called')
    })
    const { app } = buildApp({
      prisma: { podRound: { findUnique, update }, podRoundSignup: { upsert, findMany } },
      ptp: { createPod },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-9', username: 'PlayerNine', sourceGuildId: 'guild-1', action: 'in' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ error: 'This round has already started — no need to sign up.' })
  })

  it('rejects a signup body missing a required field with 400, before reading the round', async () => {
    const findUnique = stubPodRoundFindUnique(async () => {
      throw new Error('podRound.findUnique should not have been called')
    })
    const { app } = buildApp({ prisma: { podRound: { findUnique } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/signup',
      payload: { discordId: 'player-1', username: 'PlayerOne' }, // no sourceGuildId
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /pods/:id/cancel', () => {
  it('returns 404 when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const { app } = buildApp({ prisma: { podRound: { findUnique } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/cancel',
      payload: { requestedBy: 'organizer-1' },
    })

    expect(response.statusCode).toBe(404)
  })

  it("returns 403 when the requester is not the round's organizer", async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow())
    const update = stub(async (_args: PodRoundUpdateArgs) => {
      throw new Error('podRound.update should not have been called')
    })
    const { app } = buildApp({ prisma: { podRound: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/cancel',
      payload: { requestedBy: 'someone-else' },
    })

    expect(response.statusCode).toBe(403)
  })

  it('cancels the round when the requester is the organizer', async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow())
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'CANCELLED' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected podRound.update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const { app } = buildApp({ prisma: { podRound: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/pods/round-1/cancel',
      payload: { requestedBy: 'organizer-1' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('rejects a missing requestedBy with 400, before reading the round', async () => {
    const findUnique = stubPodRoundFindUnique(async () => {
      throw new Error('podRound.findUnique should not have been called')
    })
    const { app } = buildApp({ prisma: { podRound: { findUnique } } })

    const response = await app.inject({ method: 'POST', url: '/pods/round-1/cancel', payload: {} })

    expect(response.statusCode).toBe(400)
  })
})
