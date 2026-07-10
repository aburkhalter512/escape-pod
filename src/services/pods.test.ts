import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { AppPrismaClient } from '../prismaClient.js'
import type { CreatePodParams } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { NotFoundError, ForbiddenError } from './errors.js'
import {
  recordSignup,
  cancelPod,
  cancelActiveRound,
  recordTargetMessage,
  expireOverdueRounds,
  startPod,
  type PodServiceDeps,
} from './pods.js'

const TOKEN_KEY = '00'.repeat(32)

type PodRoundRow = Awaited<ReturnType<AppPrismaClient['podRound']['create']>>
type PodRoundCreateArgs = Parameters<AppPrismaClient['podRound']['create']>[0]
type PodRoundUpdateArgs = Parameters<AppPrismaClient['podRound']['update']>[0]
type PodRoundUpdateManyArgs = Parameters<AppPrismaClient['podRound']['updateMany']>[0]
type PodRoundFindManyArgs = Parameters<AppPrismaClient['podRound']['findMany']>[0]
type PodRoundWithOrganizer = Prisma.PodRoundGetPayload<{ include: { organizer: true } }>
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

function stubPodRoundFindUnique<Result>(impl: () => Promise<Result>) {
  function findUnique<T extends Prisma.PodRoundFindUniqueArgs>(
    _args: Prisma.SelectSubset<T, Prisma.PodRoundFindUniqueArgs>
  ): Promise<Prisma.PodRoundGetPayload<T> | null> {
    return impl() as unknown as Promise<Prisma.PodRoundGetPayload<T> | null>
  }
  return findUnique
}

function stubPodRoundFindMany<Result>(impl: () => Promise<Result[]>) {
  function findMany<T extends Prisma.PodRoundFindManyArgs>(
    _args: Prisma.SelectSubset<T, Prisma.PodRoundFindManyArgs>
  ): Promise<Prisma.PodRoundGetPayload<T>[]> {
    return impl() as unknown as Promise<Prisma.PodRoundGetPayload<T>[]>
  }
  return findMany
}

function buildDeps(overrides: FakePrismaOverrides = {}): PodServiceDeps {
  return {
    prisma: createFakePrismaClient(overrides),
    ptp: createFakePtpClient(),
    tokenEncryptionKey: TOKEN_KEY,
    logger: { error: () => {} },
  }
}

describe('recordTargetMessage', () => {
  it('throws NotFoundError when there is no target for that round/guild pair', async () => {
    const findUnique = stub(async () => null)
    const deps = buildDeps({ podRoundTarget: { findUnique } })

    await expect(
      recordTargetMessage(deps, { podRoundId: 'round-1', guildId: 'unknown-guild', messageId: 'msg-1' })
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('recordSignup', () => {
  it('throws NotFoundError when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const deps = buildDeps({ podRound: { findUnique } })

    await expect(
      recordSignup(deps, { podRoundId: 'round-1', discordId: 'p1', username: 'P1', sourceGuildId: 'g1', action: 'in' })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('only calls PTP once when two signups race to push the round past threshold (tasks/001)', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    let claimed = false
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const expected: PodRoundUpdateManyArgs = {
        where: { id: 'round-1', status: 'COLLECTING' },
        data: { status: 'THRESHOLD_REACHED' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected updateMany args: ${JSON.stringify(args)}`)
      if (claimed) return { count: 0 }
      claimed = true
      return { count: 1 }
    })
    const update = stub(async () => fakePodRoundRow())
    const upsert = stub(async (_args: PodRoundSignupUpsertArgs) => fakePodRoundSignupRow())
    const count = stub(async () => 8)
    const createPod = stub(async (_token: string, _params: CreatePodParams) => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, update, updateMany },
        podRoundSignup: { upsert, count },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const [resultA, resultB] = await Promise.all([
      recordSignup(deps, { podRoundId: 'round-1', discordId: 'p7', username: 'P7', sourceGuildId: 'g1', action: 'in' }),
      recordSignup(deps, { podRoundId: 'round-1', discordId: 'p8', username: 'P8', sourceGuildId: 'g1', action: 'in' }),
    ])

    expect(createPod.calls).toHaveLength(1)
    expect([resultA.podCreated, resultB.podCreated].filter(Boolean)).toHaveLength(1)
  })

  it('logs (not throws) when PTP pod creation fails after threshold reached', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => ({ count: 1 }))
    const upsert = stub(async () => fakePodRoundSignupRow())
    const count = stub(async () => 8)
    const createPod = stub(async () => {
      throw new Error('PTP pod creation failed: 401')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, updateMany },
        podRoundSignup: { upsert, count },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: (obj) => errors.push(obj) },
    }

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p8',
      username: 'P8',
      sourceGuildId: 'g1',
      action: 'in',
    })

    expect(result).toMatchObject({ full: true, podCreated: false })
    expect(errors).toHaveLength(1)
  })

  it('does not fire early just because count reaches the round\'s (lower) threshold — only a full table triggers it', async () => {
    const round = fakeRoundWithOrganizer({ threshold: 2 })
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => {
      throw new Error('podRound.updateMany should not have been called below POD_CAPACITY')
    })
    const upsert = stub(async () => fakePodRoundSignupRow())
    const count = stub(async () => 3) // >= threshold (2), well short of POD_CAPACITY (8)
    const createPod = stub(async () => {
      throw new Error('createPod should not have been called below POD_CAPACITY')
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, updateMany },
        podRoundSignup: { upsert, count },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p3',
      username: 'P3',
      sourceGuildId: 'g1',
      action: 'in',
    })

    expect(result).toMatchObject({ count: 3, threshold: 2, full: false, podCreated: false })
  })
})

describe('cancelPod', () => {
  it('throws NotFoundError when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const deps = buildDeps({ podRound: { findUnique } })

    await expect(cancelPod(deps, { podRoundId: 'round-1', requestedBy: 'organizer-1' })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it("throws ForbiddenError when the requester is not the round's organizer", async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow())
    const deps = buildDeps({ podRound: { findUnique } })

    await expect(cancelPod(deps, { podRoundId: 'round-1', requestedBy: 'someone-else' })).rejects.toBeInstanceOf(
      ForbiddenError
    )
  })
})

describe('cancelActiveRound', () => {
  it('returns null when the organizer has no active round', async () => {
    const findFirst = stub(async () => null)
    const deps = buildDeps({ podRound: { findFirst } })

    const result = await cancelActiveRound(deps, 'organizer-1')

    expect(result).toBeNull()
  })

  it('queries for the most recent COLLECTING/THRESHOLD_REACHED round, scoped to this organizer', async () => {
    const findFirst = stub(async (args: unknown) => {
      const expected = {
        where: { organizerDiscordId: 'organizer-1', status: { in: ['COLLECTING', 'THRESHOLD_REACHED'] } },
        orderBy: { createdAt: 'desc' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected findFirst args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1' })
    })
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1' }))
    const update = stub(async () => fakePodRoundRow())
    const findMany = stub(async () => [])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    await cancelActiveRound(deps, 'organizer-1')

    expect(findFirst.calls).toHaveLength(1)
  })

  it('cancels the found round and returns its setCode + targets', async () => {
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1', setCode: 'JTL' }))
    const findUnique = stubPodRoundFindUnique(async () =>
      fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1', setCode: 'JTL' })
    )
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'CANCELLED' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const findMany = stub(async () => [
      { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
      { podRoundId: 'round-1', guildId: 'g2', channelId: 'channel-2', messageId: null, approvalStatus: null, postedAt: new Date() },
    ])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    const result = await cancelActiveRound(deps, 'organizer-1')

    expect(result).toEqual({
      podRoundId: 'round-1',
      setCode: 'JTL',
      originGuildName: null,
      targets: [
        { channelId: 'channel-1', messageId: 'msg-1' },
        { channelId: 'channel-2', messageId: null },
      ],
    })
  })

  it('carries the origin guild name through to the result', async () => {
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-1', originGuildName: 'Sister Community' }))
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ id: 'round-1' }))
    const update = stub(async () => fakePodRoundRow())
    const findMany = stub(async () => [])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    const result = await cancelActiveRound(deps, 'organizer-1')

    expect(result?.originGuildName).toBe('Sister Community')
  })
})

describe('startPod', () => {
  it('stores scheduledFor on the created round when provided', async () => {
    const create = stub(async (args: PodRoundCreateArgs) => {
      expect(args.data.scheduledFor).toEqual(new Date('2026-01-01T12:00:00Z'))
      return fakePodRoundRow()
    })
    const findMany = stub(async (_args: unknown) => [])
    const deps = buildDeps({ podRound: { create }, guildSubscription: { findMany } })

    await startPod(deps, {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: [],
      scheduledFor: new Date('2026-01-01T12:00:00Z'),
    })

    expect(create.calls).toHaveLength(1)
  })

  it('stores originGuildName on the created round when provided', async () => {
    const create = stub(async (args: PodRoundCreateArgs) => {
      expect(args.data.originGuildName).toBe('Sister Community')
      return fakePodRoundRow()
    })
    const findMany = stub(async (_args: unknown) => [])
    const deps = buildDeps({ podRound: { create }, guildSubscription: { findMany } })

    await startPod(deps, {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: [],
      originGuildName: 'Sister Community',
    })

    expect(create.calls).toHaveLength(1)
  })
})

describe('expireOverdueRounds', () => {
  it('queries for COLLECTING rounds past their deadline', async () => {
    const now = new Date('2026-01-01T12:00:00Z')
    const findManyRounds = stub(async (args: PodRoundFindManyArgs) => {
      const where = args?.where as { status?: unknown; scheduledFor?: { lte?: Date } } | undefined
      expect(where?.status).toBe('COLLECTING')
      expect(where?.scheduledFor?.lte?.getTime()).toBeGreaterThanOrEqual(now.getTime())
      return []
    })
    const deps = buildDeps({ podRound: { findMany: findManyRounds } })

    await expireOverdueRounds(deps)

    expect(findManyRounds.calls).toHaveLength(1)
  })

  it('expires a round that never reached its own minimum threshold by the deadline', async () => {
    const findManyRounds = stubPodRoundFindMany(async () => [fakePodRoundRow({ id: 'round-1', setCode: 'JTL', threshold: 6 })])
    const count = stub(async () => 3) // below threshold: 6
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const expected: PodRoundUpdateManyArgs = { where: { id: 'round-1', status: 'COLLECTING' }, data: { status: 'EXPIRED' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected updateMany args: ${JSON.stringify(args)}`)
      return { count: 1 }
    })
    const findManyTargets = stub(async () => [
      { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
    ])
    const deps = buildDeps({
      podRound: { findMany: findManyRounds, updateMany },
      podRoundSignup: { count },
      podRoundTarget: { findMany: findManyTargets },
    })

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([
      {
        podRoundId: 'round-1',
        setCode: 'JTL',
        outcome: 'expired',
        originGuildName: null,
        targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      },
    ])
  })

  it('fires a round short of a full table if it reached its own minimum threshold by the deadline', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', setCode: 'JTL', threshold: 2 })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    const count = stub(async () => 5) // >= threshold (2), short of POD_CAPACITY (8)
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const expected: PodRoundUpdateManyArgs = { where: { id: 'round-1', status: 'COLLECTING' }, data: { status: 'THRESHOLD_REACHED' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected updateMany args: ${JSON.stringify(args)}`)
      return { count: 1 }
    })
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'POD_CREATED', ptpPodShareId: 'share-1' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const createPod = stub(async (token: string, params: CreatePodParams) => {
      const validArgs = token === 'a-real-token' && deepEqual(params, { setCode: 'JTL', maxPlayers: 5 })
      if (!validArgs) throw new Error(`unexpected createPod args: ${token} ${JSON.stringify(params)}`)
      return {
        id: 'ptp-pod-1',
        shareId: 'share-1',
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        createdAt: '2026-01-01T00:00:00Z',
      }
    })
    const findManyTargets = stub(async () => [
      { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
    ])
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findMany: findManyRounds, updateMany, update },
        podRoundSignup: { count },
        podRoundTarget: { findMany: findManyTargets },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([
      {
        podRoundId: 'round-1',
        setCode: 'JTL',
        outcome: 'fired',
        count: 5,
        threshold: 2,
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        originGuildName: null,
        targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      },
    ])
  })

  it('does not surface a result when firing at the deadline fails after the claim (logs instead)', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', threshold: 2 })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    const count = stub(async () => 5)
    const updateMany = stub(async () => ({ count: 1 }))
    const createPod = stub(async () => {
      throw new Error('PTP pod creation failed: 401')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findMany: findManyRounds, updateMany },
        podRoundSignup: { count },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: (obj) => errors.push(obj) },
    }

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('skips a round that another concurrent sweep (or a racing signup) already claimed', async () => {
    const findManyRounds = stubPodRoundFindMany(async () => [fakePodRoundRow({ id: 'round-1' })])
    const count = stub(async () => 3) // below the default threshold (8) — takes the expire path
    const updateMany = stub(async () => ({ count: 0 }))
    const findManyTargets = stub(async () => {
      throw new Error('podRoundTarget.findMany should not have been called for an unclaimed round')
    })
    const deps = buildDeps({
      podRound: { findMany: findManyRounds, updateMany },
      podRoundSignup: { count },
      podRoundTarget: { findMany: findManyTargets },
    })

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([])
  })

  it('returns an empty array when nothing is overdue', async () => {
    const findManyRounds = stub(async () => [])
    const deps = buildDeps({ podRound: { findMany: findManyRounds } })

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([])
  })
})
