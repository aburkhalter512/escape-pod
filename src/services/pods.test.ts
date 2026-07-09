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
import { recordSignup, cancelPod, recordTargetMessage, type PodServiceDeps } from './pods.js'

const TOKEN_KEY = '00'.repeat(32)

type PodRoundRow = Awaited<ReturnType<AppPrismaClient['podRound']['create']>>
type PodRoundUpdateManyArgs = Parameters<AppPrismaClient['podRound']['updateMany']>[0]
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
    ptpPodShareId: null,
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

    expect(result).toMatchObject({ thresholdReached: true, podCreated: false })
    expect(errors).toHaveLength(1)
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
