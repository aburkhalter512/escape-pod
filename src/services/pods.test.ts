import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { AppPrismaClient } from '../prismaClient.js'
import type { CreatePodParams } from '../ptp/client.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import {
  recordSignup,
  cancelPod,
  cancelActiveRound,
  concludePod,
  concludeActiveRound,
  recordTargetMessage,
  expireOverdueRounds,
  retryFailedFires,
  startPod,
  listActiveRoundsForOrganizer,
  type PodServiceDeps,
  type OnFiringHook,
  type OnRetrySuccessHook,
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
    organizerRoundNumber: 1,
    setCode: 'JTL',
    threshold: 8,
    status: 'COLLECTING',
    scheduledFor: null,
    ptpPodShareId: null,
    originGuildName: null,
    originGuildId: null,
    chatChannelId: null,
    thresholdReachedAt: null,
    fireFailureNotified: false,
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
      nextRoundNumber: 2,
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

// Same generic-satisfying trick as stubPodRoundFindMany above, but
// forwards the real args through to impl — needed when a test wants to
// assert on the exact where/orderBy shape a call site builds (see
// listActiveRoundsForOrganizer's tests), not just control the return value.
function stubPodRoundFindManyWithArgs<Result>(impl: (args: PodRoundFindManyArgs) => Promise<Result[]>) {
  function findMany<T extends Prisma.PodRoundFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.PodRoundFindManyArgs>
  ): Promise<Prisma.PodRoundGetPayload<T>[]> {
    return impl(args as PodRoundFindManyArgs) as unknown as Promise<Prisma.PodRoundGetPayload<T>[]>
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

// startPod's atomic round-numbering claim (see startPod's own doc
// comment) reads the organizer row back via organizer.update — every
// startPod test needs this stubbed, since the fake Prisma client's
// default throws if a method is called without an override.
function stubOrganizerNextRoundNumber(nextRoundNumber = 2) {
  return stub(async () => ({
    discordId: 'organizer-1',
    username: 'OrganizerOne',
    encryptedToken: encryptToken('a-real-token', TOKEN_KEY),
    expiresAt: new Date(),
    linkedAt: new Date(),
    nextRoundNumber,
  }))
}

describe('recordTargetMessage', () => {
  it('returns a not_found error when there is no target for that round/guild pair', async () => {
    const findUnique = stub(async () => null)
    const deps = buildDeps({ podRoundTarget: { findUnique } })

    const result = await recordTargetMessage(deps, { podRoundId: 'round-1', guildId: 'unknown-guild', messageId: 'msg-1' })

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', message: 'Pod round target not found' } })
  })
})

describe('recordSignup', () => {
  it('returns a not_found error when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const deps = buildDeps({ podRound: { findUnique } })

    const result = await recordSignup(deps, { podRoundId: 'round-1', discordId: 'p1', username: 'P1', sourceGuildId: 'g1', action: 'in' })

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', message: 'Pod round not found' } })
  })

  // Regression guard (bug found live): a round can leave COLLECTING for a
  // reason unrelated to this specific call — an earlier signup already
  // pushed it to POD_CAPACITY, the periodic deadline sweep
  // (jobs/expirePodRounds.ts) already fired or expired it, or /cancel-pod
  // already cancelled it. The correct RSVP message for all of those is
  // already in place; recordSignup used to still upsert the signup and
  // build a "still collecting" response regardless, which let a late click
  // overwrite that correct terminal-state message with a stale one. Each
  // case below asserts both the status-appropriate error AND that neither
  // the upsert nor the count query ever runs.
  const terminalStatusCases: Array<{ status: 'THRESHOLD_REACHED' | 'POD_CREATED' | 'CANCELLED' | 'EXPIRED'; message: string }> = [
    { status: 'THRESHOLD_REACHED', message: 'This round has already started — no need to sign up.' },
    { status: 'POD_CREATED', message: 'This round has already started — no need to sign up.' },
    { status: 'CANCELLED', message: 'This round was cancelled by the organizer.' },
    { status: 'EXPIRED', message: 'This round expired before enough players joined.' },
  ]

  for (const { status, message } of terminalStatusCases) {
    it(`returns a validation error and does not upsert/list signups when the round is already ${status}`, async () => {
      const round = fakeRoundWithOrganizer({ status })
      const findUnique = stubPodRoundFindUnique(async () => round)
      const upsert = stub(async () => {
        throw new Error('podRoundSignup.upsert should not have been called for a non-COLLECTING round')
      })
      const findMany = stub(async () => {
        throw new Error('podRoundSignup.findMany should not have been called for a non-COLLECTING round')
      })
      const deps = buildDeps({
        podRound: { findUnique },
        podRoundSignup: { upsert, findMany },
      })

      const result = await recordSignup(deps, {
        podRoundId: 'round-1',
        discordId: 'p1',
        username: 'P1',
        sourceGuildId: 'g1',
        action: 'in',
      })

      expect(result).toEqual({ ok: false, error: { kind: 'validation', message } })
      expect(upsert.calls).toHaveLength(0)
      expect(findMany.calls).toHaveLength(0)
    })
  }

  it('only calls PTP once when two signups race to push the round past threshold (tasks/001)', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    let claimed = false
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const where = args.where as { id?: string; status?: string } | undefined
      const data = args.data as { status?: string; thresholdReachedAt?: unknown } | undefined
      const argsLookRight =
        where?.id === 'round-1' &&
        where.status === 'COLLECTING' &&
        data?.status === 'THRESHOLD_REACHED' &&
        data.thresholdReachedAt instanceof Date
      if (!argsLookRight) throw new Error(`unexpected updateMany args: ${JSON.stringify(args)}`)
      if (claimed) return { count: 0 }
      claimed = true
      return { count: 1 }
    })
    const update = stub(async () => fakePodRoundRow())
    const upsert = stub(async (_args: PodRoundSignupUpsertArgs) => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is now derived from this
    // findMany's length, not a separate .count() call.
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
      fakePodRoundSignupRow({ discordId: 'p6' }),
      fakePodRoundSignupRow({ discordId: 'p7' }),
      fakePodRoundSignupRow({ discordId: 'p8' }),
    ])
    const createPod = stub(async (_token: string, _params: CreatePodParams) => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, update, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
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
    expect(resultA.ok && resultB.ok).toBe(true)
    const podCreatedFlags = [resultA, resultB].map((r) => r.ok && r.value.podCreated)
    expect(podCreatedFlags.filter(Boolean)).toHaveLength(1)
    expect(resultA.ok && resultA.value.signupDiscordIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
  })

  it('logs (not throws) when PTP pod creation fails after threshold reached', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => ({ count: 1 }))
    const upsert = stub(async () => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
      fakePodRoundSignupRow({ discordId: 'p6' }),
      fakePodRoundSignupRow({ discordId: 'p7' }),
      fakePodRoundSignupRow({ discordId: 'p8' }),
    ])
    const createPod = stub(async () => {
      throw new Error('PTP pod creation failed: 401')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
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

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      full: true,
      podCreated: false,
      signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    })
    expect(errors).toHaveLength(1)
  })

  it('does not fire early just because count reaches the round\'s (lower) threshold — only a full table triggers it', async () => {
    const round = fakeRoundWithOrganizer({ threshold: 2 })
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => {
      throw new Error('podRound.updateMany should not have been called below POD_CAPACITY')
    })
    const upsert = stub(async () => fakePodRoundSignupRow())
    // >= threshold (2), well short of POD_CAPACITY (8)
    const findMany = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
    ])
    const createPod = stub(async () => {
      throw new Error('createPod should not have been called below POD_CAPACITY')
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, updateMany },
        podRoundSignup: { upsert, findMany },
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

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      count: 3,
      threshold: 2,
      full: false,
      podCreated: false,
      signupDiscordIds: ['p1', 'p2', 'p3'],
    })
  })

  it('sorts signupDiscordIds by usernameSnapshot, case-insensitively, not by insertion order', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const upsert = stub(async () => fakePodRoundSignupRow())
    const findMany = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'charlie-id', usernameSnapshot: 'charlie' }),
      fakePodRoundSignupRow({ discordId: 'alice-id', usernameSnapshot: 'Alice' }),
      fakePodRoundSignupRow({ discordId: 'bob-id', usernameSnapshot: 'bob' }),
    ])
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique },
        podRoundSignup: { upsert, findMany },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'alice-id',
      username: 'Alice',
      sourceGuildId: 'g1',
      action: 'in',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.signupDiscordIds).toEqual(['alice-id', 'bob-id', 'charlie-id'])
  })

  it("carries the round's scheduledFor through to the result (regression guard — this used to be dropped on every signup rebuild)", async () => {
    const scheduledFor = new Date('2026-01-01T12:00:00Z')
    const round = fakeRoundWithOrganizer({ scheduledFor })
    const findUnique = stubPodRoundFindUnique(async () => round)
    const upsert = stub(async () => fakePodRoundSignupRow())
    const findMany = stub(async () => [fakePodRoundSignupRow({ discordId: 'p3' })])
    const deps = buildDeps({
      podRound: { findUnique },
      podRoundSignup: { upsert, findMany },
      podRoundTarget: { findMany: stub(async () => []) },
    })

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p3',
      username: 'P3',
      sourceGuildId: 'g1',
      action: 'in',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.scheduledFor).toEqual(scheduledFor)
  })

  it('returns scheduledFor: null when the round has no deadline set', async () => {
    const round = fakeRoundWithOrganizer({ scheduledFor: null })
    const findUnique = stubPodRoundFindUnique(async () => round)
    const upsert = stub(async () => fakePodRoundSignupRow())
    const findMany = stub(async () => [fakePodRoundSignupRow({ discordId: 'p3' })])
    const deps = buildDeps({
      podRound: { findUnique },
      podRoundSignup: { upsert, findMany },
      podRoundTarget: { findMany: stub(async () => []) },
    })

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p3',
      username: 'P3',
      sourceGuildId: 'g1',
      action: 'in',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.scheduledFor).toBeNull()
  })

  it('invokes onFiring with the right ctx exactly once, before ptp.createPod, and threads its chatUrl through', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', setCode: 'JTL', organizerDiscordId: 'organizer-1' })
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => ({ count: 1 }))
    const update = stub(async () => fakePodRoundRow())
    const upsert = stub(async () => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call. onFiring's own ctx
    // still gets fireRound's own separate signupDiscordIds fetch (see
    // fireRound in services/pods.ts), which happens to read the same rows.
    const eightSignups = [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
      fakePodRoundSignupRow({ discordId: 'p6' }),
      fakePodRoundSignupRow({ discordId: 'p7' }),
      fakePodRoundSignupRow({ discordId: 'p8' }),
    ]
    const findManySignups = stub(async () => eightSignups)

    const callOrder: string[] = []
    const onFiring = stub(async (ctx: Parameters<OnFiringHook>[0]) => {
      callOrder.push('onFiring')
      expect(ctx).toEqual({
        setCode: 'JTL',
        organizerDiscordId: 'organizer-1',
        originGuildId: round.originGuildId,
        signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      })
      return { channelId: 'chat-channel-1', chatUrl: 'https://discord.com/invite/abc123' }
    })
    const createPod = stub(async () => {
      callOrder.push('createPod')
      return {
        id: 'ptp-pod-1',
        shareId: 'share-1',
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        createdAt: '2026-01-01T00:00:00Z',
      }
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, update, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p8',
      username: 'P8',
      sourceGuildId: 'g1',
      action: 'in',
      onFiring,
    })

    expect(onFiring.calls).toHaveLength(1)
    expect(callOrder).toEqual(['onFiring', 'createPod'])
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      chatUrl: 'https://discord.com/invite/abc123',
      chatChannelId: 'chat-channel-1',
      signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    })
  })

  it('still runs onFiring before ptp.createPod even when createPod then rejects — the hook already ran and cannot be undone', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => ({ count: 1 }))
    const upsert = stub(async () => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
      fakePodRoundSignupRow({ discordId: 'p6' }),
      fakePodRoundSignupRow({ discordId: 'p7' }),
      fakePodRoundSignupRow({ discordId: 'p8' }),
    ])

    const callOrder: string[] = []
    const onFiring = stub(async () => {
      callOrder.push('onFiring')
      return { channelId: 'chat-channel-1', chatUrl: 'https://discord.com/invite/abc123' }
    })
    const createPod = stub(async () => {
      callOrder.push('createPod')
      throw new Error('PTP pod creation failed: 401')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
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
      onFiring,
    })

    expect(callOrder).toEqual(['onFiring', 'createPod'])
    expect(result.ok).toBe(true)
    // The hook already ran and returned a chatUrl/chatChannelId by the time
    // createPod rejected — podCreated correctly reflects only
    // ptp.createPod's outcome, but chatUrl/chatChannelId/signupDiscordIds
    // still come back since onFiring itself succeeded before the failure.
    expect(result.ok && result.value).toMatchObject({
      podCreated: false,
      chatUrl: 'https://discord.com/invite/abc123',
      chatChannelId: 'chat-channel-1',
      signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    })
  })

  it('omitting onFiring entirely does not change podCreated/shareUrl outcomes (regression guard)', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => ({ count: 1 }))
    const update = stub(async () => fakePodRoundRow())
    const upsert = stub(async () => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const eightSignups = [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
      fakePodRoundSignupRow({ discordId: 'p6' }),
      fakePodRoundSignupRow({ discordId: 'p7' }),
      fakePodRoundSignupRow({ discordId: 'p8' }),
    ]
    const findManySignups = stub(async () => eightSignups)
    const createPod = stub(async () => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, update, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p8',
      username: 'P8',
      sourceGuildId: 'g1',
      action: 'in',
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      chatUrl: undefined,
      chatChannelId: undefined,
      signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    })
  })

  it('onFiring resolving to undefined leaves chatUrl/chatChannelId undefined without affecting podCreated/shareUrl', async () => {
    const round = fakeRoundWithOrganizer()
    const findUnique = stubPodRoundFindUnique(async () => round)
    const updateMany = stub(async () => ({ count: 1 }))
    const update = stub(async () => fakePodRoundRow())
    const upsert = stub(async () => fakePodRoundSignupRow())
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findMany's length, not a separate .count() call.
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
      fakePodRoundSignupRow({ discordId: 'p6' }),
      fakePodRoundSignupRow({ discordId: 'p7' }),
      fakePodRoundSignupRow({ discordId: 'p8' }),
    ])
    const onFiring: OnFiringHook = async () => undefined
    const createPod = stub(async () => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findUnique, update, updateMany },
        podRoundSignup: { upsert, findMany: findManySignups },
        podRoundTarget: { findMany: stub(async () => []) },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await recordSignup(deps, {
      podRoundId: 'round-1',
      discordId: 'p8',
      username: 'P8',
      sourceGuildId: 'g1',
      action: 'in',
      onFiring,
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      chatUrl: undefined,
      chatChannelId: undefined,
    })
  })
})

describe('cancelPod', () => {
  it('returns a not_found error when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const deps = buildDeps({ podRound: { findUnique } })

    const result = await cancelPod(deps, { podRoundId: 'round-1', requestedBy: 'organizer-1' })

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', message: 'Pod round not found' } })
  })

  it("returns a forbidden error when the requester is not the round's organizer", async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow())
    const deps = buildDeps({ podRound: { findUnique } })

    const result = await cancelPod(deps, { podRoundId: 'round-1', requestedBy: 'someone-else' })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'forbidden', message: "Only the organizer who started this round can cancel it" },
    })
  })
})

describe('cancelActiveRound', () => {
  it('returns null when the organizer has no active round', async () => {
    const findFirst = stub(async () => null)
    const deps = buildDeps({ podRound: { findFirst } })

    const result = await cancelActiveRound(deps, 'organizer-1')

    expect(result).toBeNull()
  })

  it('queries for the most recent round of any status, scoped to this organizer', async () => {
    const findFirst = stub(async (args: unknown) => {
      const expected = {
        where: { organizerDiscordId: 'organizer-1' },
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

  // GitHub issue #6 — when organizerRoundNumber is given, resolves that
  // exact round (via the unique constraint) instead of guessing at "most
  // recent," so an organizer can cancel an older round even while a
  // newer one is also active.
  it('resolves the exact round by organizerRoundNumber when given, instead of most-recent', async () => {
    const findFirst = stub(async (args: unknown) => {
      const expected = { where: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2 } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected findFirst args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ id: 'round-2', organizerDiscordId: 'organizer-1', organizerRoundNumber: 2 })
    })
    const findUnique = stubPodRoundFindUnique(async () =>
      fakePodRoundRow({ id: 'round-2', organizerDiscordId: 'organizer-1', organizerRoundNumber: 2 })
    )
    const update = stub(async () => fakePodRoundRow())
    const findMany = stub(async () => [])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    const result = await cancelActiveRound(deps, 'organizer-1', 2)

    expect(findFirst.calls).toHaveLength(1)
    expect(result?.podRoundId).toBe('round-2')
  })

  it('returns null (does not reach back to an older round) when the most recent round already fired', async () => {
    // Regression: the query used to filter to cancellable statuses
    // first, so it would silently skip a more recent already-fired round
    // and cancel an older still-COLLECTING one instead — cancelling a
    // round the organizer had already moved on from.
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-2', status: 'POD_CREATED' }))
    const update = stub(async () => {
      throw new Error('podRound.update should not have been called')
    })
    const deps = buildDeps({ podRound: { findFirst, update } })

    const result = await cancelActiveRound(deps, 'organizer-1')

    expect(result).toBeNull()
    expect(update.calls).toHaveLength(0)
  })

  it('returns null when the most recent round was already cancelled or expired', async () => {
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-2', status: 'EXPIRED' }))
    const deps = buildDeps({ podRound: { findFirst } })

    const result = await cancelActiveRound(deps, 'organizer-1')

    expect(result).toBeNull()
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
      organizerRoundNumber: 1,
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

describe('concludePod', () => {
  it('returns a not_found error when the round does not exist', async () => {
    const findUnique = stubPodRoundFindUnique(async () => null)
    const deps = buildDeps({ podRound: { findUnique } })

    const result = await concludePod(deps, { podRoundId: 'round-1', requestedBy: 'organizer-1' })

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', message: 'Pod round not found' } })
  })

  it("returns a forbidden error when the requester is not the round's organizer", async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ status: 'POD_CREATED' }))
    const deps = buildDeps({ podRound: { findUnique } })

    const result = await concludePod(deps, { podRoundId: 'round-1', requestedBy: 'someone-else' })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'forbidden', message: 'Only the organizer who started this round can conclude it' },
    })
  })

  it.each([
    ['COLLECTING', "This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?"],
    ['THRESHOLD_REACHED', "This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?"],
    ['CANCELLED', 'This round was already cancelled.'],
    ['EXPIRED', 'This round already expired.'],
    ['CONCLUDED', 'This round has already been concluded.'],
  ] as const)('returns a validation error with a distinct message when status is %s', async (status, message) => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ status }))
    const deps = buildDeps({ podRound: { findUnique } })

    const result = await concludePod(deps, { podRoundId: 'round-1', requestedBy: 'organizer-1' })

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message } })
  })

  it('transitions POD_CREATED to CONCLUDED and returns ok', async () => {
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ status: 'POD_CREATED' }))
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'CONCLUDED' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ status: 'CONCLUDED' })
    })
    const deps = buildDeps({ podRound: { findUnique, update } })

    const result = await concludePod(deps, { podRoundId: 'round-1', requestedBy: 'organizer-1' })

    expect(result).toEqual({ ok: true, value: undefined })
    expect(update.calls).toHaveLength(1)
  })
})

describe('concludeActiveRound', () => {
  it('returns a not_found error when the organizer has no round at all', async () => {
    const findFirst = stub(async () => null)
    const deps = buildDeps({ podRound: { findFirst } })

    const result = await concludeActiveRound(deps, 'organizer-1')

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', message: "You don't have a pod round to conclude." } })
  })

  it('queries for the most recent round of any status, scoped to this organizer', async () => {
    const findFirst = stub(async (args: unknown) => {
      const expected = {
        where: { organizerDiscordId: 'organizer-1' },
        orderBy: { createdAt: 'desc' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected findFirst args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1', status: 'POD_CREATED' })
    })
    const findUnique = stubPodRoundFindUnique(async () =>
      fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1', status: 'POD_CREATED' })
    )
    const update = stub(async () => fakePodRoundRow({ status: 'CONCLUDED' }))
    const findMany = stub(async () => [])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    await concludeActiveRound(deps, 'organizer-1')

    expect(findFirst.calls).toHaveLength(1)
  })

  it('resolves the exact round by organizerRoundNumber when given, instead of most-recent', async () => {
    const findFirst = stub(async (args: unknown) => {
      const expected = { where: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2 } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected findFirst args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ id: 'round-2', organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, status: 'POD_CREATED' })
    })
    const findUnique = stubPodRoundFindUnique(async () =>
      fakePodRoundRow({ id: 'round-2', organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, status: 'POD_CREATED' })
    )
    const update = stub(async () => fakePodRoundRow({ status: 'CONCLUDED' }))
    const findMany = stub(async () => [])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    const result = await concludeActiveRound(deps, 'organizer-1', 2)

    expect(findFirst.calls).toHaveLength(1)
    expect(result.ok && result.value.podRoundId).toBe('round-2')
  })

  it('does not reach back to an older round when the most recent round is already CANCELLED', async () => {
    // Regression guard mirroring cancelActiveRound's own: filtering the
    // WHERE clause to concludable statuses would silently skip a more
    // recent non-concludable round and reach back to an older POD_CREATED
    // one instead.
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-2', status: 'CANCELLED' }))
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ id: 'round-2', status: 'CANCELLED' }))
    const update = stub(async () => {
      throw new Error('podRound.update should not have been called')
    })
    const deps = buildDeps({ podRound: { findFirst, findUnique, update } })

    const result = await concludeActiveRound(deps, 'organizer-1')

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'This round was already cancelled.' } })
    expect(update.calls).toHaveLength(0)
  })

  it.each([
    ['COLLECTING', "This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?"],
    ['THRESHOLD_REACHED', "This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?"],
    ['CANCELLED', 'This round was already cancelled.'],
    ['EXPIRED', 'This round already expired.'],
    ['CONCLUDED', 'This round has already been concluded.'],
  ] as const)('surfaces a distinct validation message when the most recent round has status %s', async (status, message) => {
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-1', status }))
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ id: 'round-1', status }))
    const deps = buildDeps({ podRound: { findFirst, findUnique } })

    const result = await concludeActiveRound(deps, 'organizer-1')

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message } })
  })

  it('concludes the found round and returns its setCode, chatChannelId, and targets', async () => {
    const findFirst = stub(async () =>
      fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1', setCode: 'JTL', status: 'POD_CREATED', chatChannelId: 'chat-1' })
    )
    const findUnique = stubPodRoundFindUnique(async () =>
      fakePodRoundRow({ id: 'round-1', organizerDiscordId: 'organizer-1', setCode: 'JTL', status: 'POD_CREATED', chatChannelId: 'chat-1' })
    )
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'CONCLUDED' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ status: 'CONCLUDED' })
    })
    const findMany = stub(async () => [
      { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
      { podRoundId: 'round-1', guildId: 'g2', channelId: 'channel-2', messageId: null, approvalStatus: null, postedAt: new Date() },
    ])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    const result = await concludeActiveRound(deps, 'organizer-1')

    expect(result).toEqual({
      ok: true,
      value: {
        podRoundId: 'round-1',
        setCode: 'JTL',
        organizerRoundNumber: 1,
        originGuildName: null,
        chatChannelId: 'chat-1',
        targets: [
          { channelId: 'channel-1', messageId: 'msg-1' },
          { channelId: 'channel-2', messageId: null },
        ],
      },
    })
  })

  it('returns a null chatChannelId when the round never got a chat channel', async () => {
    const findFirst = stub(async () => fakePodRoundRow({ id: 'round-1', status: 'POD_CREATED', chatChannelId: null }))
    const findUnique = stubPodRoundFindUnique(async () => fakePodRoundRow({ id: 'round-1', status: 'POD_CREATED', chatChannelId: null }))
    const update = stub(async () => fakePodRoundRow({ status: 'CONCLUDED' }))
    const findMany = stub(async () => [])
    const deps = buildDeps({ podRound: { findFirst, findUnique, update }, podRoundTarget: { findMany } })

    const result = await concludeActiveRound(deps, 'organizer-1')

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.chatChannelId).toBeNull()
  })
})

describe('listActiveRoundsForOrganizer', () => {
  it("queries for COLLECTING/THRESHOLD_REACHED rounds, scoped to this organizer, when kind is 'cancellable'", async () => {
    const findMany = stub(async (args: PodRoundFindManyArgs) => {
      const expected: PodRoundFindManyArgs = {
        where: { organizerDiscordId: 'organizer-1', status: { in: ['COLLECTING', 'THRESHOLD_REACHED'] } },
        orderBy: { organizerRoundNumber: 'asc' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected findMany args: ${JSON.stringify(args)}`)
      return [
        fakePodRoundRow({ id: 'round-1', organizerRoundNumber: 1, setCode: 'JTL' }),
        fakePodRoundRow({ id: 'round-3', organizerRoundNumber: 3, setCode: 'SOR' }),
      ]
    })
    const deps = buildDeps({ podRound: { findMany: stubPodRoundFindManyWithArgs(findMany) } })

    const result = await listActiveRoundsForOrganizer(deps, 'organizer-1', 'cancellable')

    expect(findMany.calls).toHaveLength(1)
    expect(result).toEqual([
      { podRoundId: 'round-1', setCode: 'JTL', organizerRoundNumber: 1 },
      { podRoundId: 'round-3', setCode: 'SOR', organizerRoundNumber: 3 },
    ])
  })

  it("queries for only POD_CREATED rounds when kind is 'concludable'", async () => {
    const findMany = stub(async (args: PodRoundFindManyArgs) => {
      const expected: PodRoundFindManyArgs = {
        where: { organizerDiscordId: 'organizer-1', status: { in: ['POD_CREATED'] } },
        orderBy: { organizerRoundNumber: 'asc' },
      }
      if (!deepEqual(args, expected)) throw new Error(`unexpected findMany args: ${JSON.stringify(args)}`)
      return [fakePodRoundRow({ id: 'round-2', organizerRoundNumber: 2, setCode: 'TWI', status: 'POD_CREATED' })]
    })
    const deps = buildDeps({ podRound: { findMany: stubPodRoundFindManyWithArgs(findMany) } })

    const result = await listActiveRoundsForOrganizer(deps, 'organizer-1', 'concludable')

    expect(result).toEqual([{ podRoundId: 'round-2', setCode: 'TWI', organizerRoundNumber: 2 }])
  })

  it('returns an empty array when the organizer has no matching rounds', async () => {
    const findMany = stub(async (_args: unknown) => [])
    const deps = buildDeps({ podRound: { findMany } })

    const result = await listActiveRoundsForOrganizer(deps, 'organizer-1', 'cancellable')

    expect(result).toEqual([])
  })
})

describe('startPod', () => {
  it('stores scheduledFor on the created round when provided', async () => {
    const create = stub(async (args: PodRoundCreateArgs) => {
      expect(args.data.scheduledFor).toEqual(new Date('2026-01-01T12:00:00Z'))
      return fakePodRoundRow()
    })
    const findMany = stub(async (_args: unknown) => [])
    const deps = buildDeps({
      podRound: { create },
      guildSubscription: { findMany },
      organizer: { update: stubOrganizerNextRoundNumber() },
    })

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
    const deps = buildDeps({
      podRound: { create },
      guildSubscription: { findMany },
      organizer: { update: stubOrganizerNextRoundNumber() },
    })

    await startPod(deps, {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: [],
      originGuildName: 'Sister Community',
    })

    expect(create.calls).toHaveLength(1)
  })

  it('stores originGuildId on the created round when provided', async () => {
    const create = stub(async (args: PodRoundCreateArgs) => {
      expect(args.data.originGuildId).toBe('guild-123')
      return fakePodRoundRow()
    })
    const findMany = stub(async (_args: unknown) => [])
    const deps = buildDeps({
      podRound: { create },
      guildSubscription: { findMany },
      organizer: { update: stubOrganizerNextRoundNumber() },
    })

    await startPod(deps, {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: [],
      originGuildId: 'guild-123',
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
    // below threshold: 6 — count is derived from this findMany's length,
    // not a separate .count() call.
    const findMany = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
    ])
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
      podRoundSignup: { findMany },
      podRoundTarget: { findMany: findManyTargets },
    })

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([
      {
        podRoundId: 'round-1',
        setCode: 'JTL',
        organizerRoundNumber: 1,
        outcome: 'expired',
        signupDiscordIds: ['p1', 'p2', 'p3'],
        originGuildName: null,
        targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      },
    ])
  })

  it('fires a round short of a full table if it reached its own minimum threshold by the deadline', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', setCode: 'JTL', threshold: 2 })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    // >= threshold (2), short of POD_CAPACITY (8) — count is derived from
    // the findMany below's length, not a separate .count() call.
    const updateMany = stub(async (args: PodRoundUpdateManyArgs) => {
      const where = args.where as { id?: string; status?: string } | undefined
      const data = args.data as { status?: string; thresholdReachedAt?: unknown } | undefined
      const argsLookRight =
        where?.id === 'round-1' &&
        where.status === 'COLLECTING' &&
        data?.status === 'THRESHOLD_REACHED' &&
        data.thresholdReachedAt instanceof Date
      if (!argsLookRight) throw new Error(`unexpected updateMany args: ${JSON.stringify(args)}`)
      return { count: 1 }
    })
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { status: 'POD_CREATED', ptpPodShareId: 'share-1' } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow()
    })
    const createPod = stub(async (token: string, params: CreatePodParams) => {
      // maxPlayers is always POD_CAPACITY (8), never the actual headcount
      // (5 here) — a round firing short of a full table at its deadline
      // still gets a full-size pod with open seats, not one capped at
      // whoever happened to have joined by then.
      const validArgs = token === 'a-real-token' && deepEqual(params, { setCode: 'JTL', maxPlayers: 8 })
      if (!validArgs) throw new Error(`unexpected createPod args: ${token} ${JSON.stringify(params)}`)
      return {
        id: 'ptp-pod-1',
        shareId: 'share-1',
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        createdAt: '2026-01-01T00:00:00Z',
      }
    })
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
    ])
    const findManyTargets = stub(async () => [
      { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
    ])
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findMany: findManyRounds, updateMany, update },
        podRoundSignup: { findMany: findManySignups },
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
        organizerRoundNumber: 1,
        outcome: 'fired',
        count: 5,
        threshold: 2,
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        chatUrl: undefined,
        chatChannelId: undefined,
        signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        originGuildName: null,
        targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      },
    ])
  })

  it('does not surface a result when firing at the deadline fails after the claim (logs instead)', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', threshold: 2 })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    const findMany = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
    ])
    const updateMany = stub(async () => ({ count: 1 }))
    const createPod = stub(async () => {
      throw new Error('PTP pod creation failed: 401')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findMany: findManyRounds, updateMany },
        podRoundSignup: { findMany },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: (obj) => errors.push(obj) },
    }

    const result = await expireOverdueRounds(deps)

    expect(result).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('invokes onFiring with the right ctx before ptp.createPod, and threads chatUrl into the fired result', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', setCode: 'JTL', threshold: 2, organizerDiscordId: 'organizer-1' })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    const updateMany = stub(async () => ({ count: 1 }))
    const update = stub(async () => fakePodRoundRow())
    // count is derived from this findMany's length, not a separate
    // .count() call.
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
    ])

    const callOrder: string[] = []
    const onFiring = stub(async (ctx: Parameters<OnFiringHook>[0]) => {
      callOrder.push('onFiring')
      expect(ctx).toEqual({
        setCode: 'JTL',
        organizerDiscordId: 'organizer-1',
        originGuildId: round.originGuildId,
        signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
      })
      return { channelId: 'chat-channel-1', chatUrl: 'https://discord.com/invite/xyz789' }
    })
    const createPod = stub(async () => {
      callOrder.push('createPod')
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
        podRoundSignup: { findMany: findManySignups },
        podRoundTarget: { findMany: findManyTargets },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverdueRounds(deps, onFiring)

    expect(onFiring.calls).toHaveLength(1)
    expect(callOrder).toEqual(['onFiring', 'createPod'])
    expect(result).toEqual([
      {
        podRoundId: 'round-1',
        setCode: 'JTL',
        organizerRoundNumber: 1,
        outcome: 'fired',
        count: 5,
        threshold: 2,
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        chatUrl: 'https://discord.com/invite/xyz789',
        chatChannelId: 'chat-channel-1',
        signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        originGuildName: null,
        targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      },
    ])
  })

  it('omitting onFiring entirely does not change the fired outcome (regression guard)', async () => {
    const round = fakeRoundWithOrganizer({ id: 'round-1', setCode: 'JTL', threshold: 2 })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    const updateMany = stub(async () => ({ count: 1 }))
    const update = stub(async () => fakePodRoundRow())
    // count is derived from this findMany's length, not a separate
    // .count() call.
    const findManySignups = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
      fakePodRoundSignupRow({ discordId: 'p4' }),
      fakePodRoundSignupRow({ discordId: 'p5' }),
    ])
    const createPod = stub(async () => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))
    const findManyTargets = stub(async () => [
      { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
    ])
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findMany: findManyRounds, updateMany, update },
        podRoundSignup: { findMany: findManySignups },
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
        organizerRoundNumber: 1,
        outcome: 'fired',
        count: 5,
        threshold: 2,
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        chatUrl: undefined,
        chatChannelId: undefined,
        signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        originGuildName: null,
        targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
      },
    ])
  })

  it('skips a round that another concurrent sweep (or a racing signup) already claimed', async () => {
    const findManyRounds = stubPodRoundFindMany(async () => [fakePodRoundRow({ id: 'round-1' })])
    // below the default threshold (8) — takes the expire path; count is
    // derived from this findMany's length, not a separate .count() call.
    const findMany = stub(async () => [
      fakePodRoundSignupRow({ discordId: 'p1' }),
      fakePodRoundSignupRow({ discordId: 'p2' }),
      fakePodRoundSignupRow({ discordId: 'p3' }),
    ])
    const updateMany = stub(async () => ({ count: 0 }))
    const findManyTargets = stub(async () => {
      throw new Error('podRoundTarget.findMany should not have been called for an unclaimed round')
    })
    const deps = buildDeps({
      podRound: { findMany: findManyRounds, updateMany },
      podRoundSignup: { findMany },
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

describe('retryFailedFires', () => {
  const NOW = new Date('2026-01-01T12:00:00Z')
  const WITHIN_WINDOW = new Date(NOW.getTime() - 10 * 60 * 1000) // 10 min ago, < 30 min window
  const PAST_WINDOW = new Date(NOW.getTime() - 31 * 60 * 1000) // 31 min ago, > 30 min window

  it('queries for THRESHOLD_REACHED rounds that have not yet been notified', async () => {
    const findManyRounds = stub(async (args: PodRoundFindManyArgs) => {
      expect(args?.where).toEqual({ status: 'THRESHOLD_REACHED', fireFailureNotified: false })
      return []
    })
    const deps = buildDeps({ podRound: { findMany: findManyRounds } })

    await retryFailedFires(deps)

    expect(findManyRounds.calls).toHaveLength(1)
  })

  it('a round with fireFailureNotified: true already set is never picked up (excluded by the query itself)', async () => {
    // The query's own where-clause is what guarantees this — asserted above
    // — but this test additionally guards that nothing downstream ever
    // even sees such a round, by returning an empty candidate set (as the
    // real query would) and confirming zero side effects follow.
    const findManyRounds = stub(async () => [])
    const updateMany = stub(async () => {
      throw new Error('podRound updates should not have been called')
    })
    const deps = buildDeps({ podRound: { findMany: findManyRounds, updateMany } })

    const result = await retryFailedFires(deps)

    expect(result).toEqual([])
  })

  it('retries and succeeds for a round within the retry window, requesting a fresh invite when chatChannelId is present', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const round = fakeRoundWithOrganizer({
        id: 'round-1',
        setCode: 'JTL',
        status: 'THRESHOLD_REACHED',
        thresholdReachedAt: WITHIN_WINDOW,
        fireFailureNotified: false,
        chatChannelId: 'chat-channel-1',
      })
      const findManyRounds = stubPodRoundFindMany(async () => [round])
      const update = stub(async (args: PodRoundUpdateArgs) => {
        const expected: PodRoundUpdateArgs = {
          where: { id: 'round-1' },
          data: { status: 'POD_CREATED', ptpPodShareId: 'share-1', chatChannelId: 'chat-channel-1' },
        }
        if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
        return fakePodRoundRow()
      })
      const findManySignups = stub(async () => [
        fakePodRoundSignupRow({ discordId: 'p1' }),
        fakePodRoundSignupRow({ discordId: 'p2' }),
      ])
      const findManyTargets = stub(async () => [
        { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
      ])
      const createPod = stub(async () => ({
        id: 'ptp-pod-1',
        shareId: 'share-1',
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        createdAt: '2026-01-01T00:00:00Z',
      }))
      const onRetrySuccess = stub(async (ctx: Parameters<OnRetrySuccessHook>[0]) => {
        expect(ctx).toEqual({ chatChannelId: 'chat-channel-1' })
        return 'https://discord.com/invite/fresh123'
      })
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: { findMany: findManyRounds, update },
          podRoundSignup: { findMany: findManySignups },
          podRoundTarget: { findMany: findManyTargets },
        }),
        ptp: createFakePtpClient({ createPod }),
        tokenEncryptionKey: TOKEN_KEY,
        logger: { error: () => {} },
      }

      const result = await retryFailedFires(deps, onRetrySuccess)

      expect(onRetrySuccess.calls).toHaveLength(1)
      expect(result).toEqual([
        {
          podRoundId: 'round-1',
          setCode: 'JTL',
          organizerRoundNumber: 1,
          outcome: 'succeeded',
          count: 2,
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          chatUrl: 'https://discord.com/invite/fresh123',
          chatChannelId: 'chat-channel-1',
          signupDiscordIds: ['p1', 'p2'],
          originGuildName: null,
          targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call the invite hook when the round has no chatChannelId', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const round = fakeRoundWithOrganizer({
        id: 'round-1',
        status: 'THRESHOLD_REACHED',
        thresholdReachedAt: WITHIN_WINDOW,
        fireFailureNotified: false,
        chatChannelId: null,
      })
      const findManyRounds = stubPodRoundFindMany(async () => [round])
      const update = stub(async () => fakePodRoundRow())
      const findManySignups = stub(async () => [fakePodRoundSignupRow({ discordId: 'p1' })])
      const findManyTargets = stub(async () => [])
      const createPod = stub(async () => ({
        id: 'ptp-pod-1',
        shareId: 'share-1',
        shareUrl: 'https://www.protectthepod.com/draft/share-1',
        createdAt: '2026-01-01T00:00:00Z',
      }))
      const onRetrySuccess = stub(async (_ctx: Parameters<OnRetrySuccessHook>[0]) => {
        throw new Error('onRetrySuccess should not have been called when chatChannelId is null')
      })
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: { findMany: findManyRounds, update },
          podRoundSignup: { findMany: findManySignups },
          podRoundTarget: { findMany: findManyTargets },
        }),
        ptp: createFakePtpClient({ createPod }),
        tokenEncryptionKey: TOKEN_KEY,
        logger: { error: () => {} },
      }

      const result = await retryFailedFires(deps, onRetrySuccess)

      expect(onRetrySuccess.calls).toHaveLength(0)
      expect(result[0]).toMatchObject({ outcome: 'succeeded', chatUrl: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves everything unchanged and pushes no result when a retry within the window fails again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const round = fakeRoundWithOrganizer({
        id: 'round-1',
        status: 'THRESHOLD_REACHED',
        thresholdReachedAt: WITHIN_WINDOW,
        fireFailureNotified: false,
      })
      const findManyRounds = stubPodRoundFindMany(async () => [round])
      const update = stub(async () => {
        throw new Error('podRound.update should not have been called — still-failing retry changes nothing')
      })
      const findManySignups = stub(async () => [fakePodRoundSignupRow({ discordId: 'p1' })])
      const createPod = stub(async () => {
        throw new Error('PTP pod creation failed: 401')
      })
      const errors: unknown[] = []
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: { findMany: findManyRounds, update },
          podRoundSignup: { findMany: findManySignups },
        }),
        ptp: createFakePtpClient({ createPod }),
        tokenEncryptionKey: TOKEN_KEY,
        logger: { error: (obj) => errors.push(obj) },
      }

      const result = await retryFailedFires(deps)

      expect(result).toEqual([])
      expect(errors).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up on a round past the retry window: sets fireFailureNotified, leaves status at THRESHOLD_REACHED, pushes a gave-up result', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const round = fakeRoundWithOrganizer({
        id: 'round-1',
        setCode: 'JTL',
        status: 'THRESHOLD_REACHED',
        thresholdReachedAt: PAST_WINDOW,
        fireFailureNotified: false,
      })
      const findManyRounds = stubPodRoundFindMany(async () => [round])
      const update = stub(async (args: PodRoundUpdateArgs) => {
        const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { fireFailureNotified: true } }
        if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
        return fakePodRoundRow({ fireFailureNotified: true })
      })
      const findManyTargets = stub(async () => [
        { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
      ])
      const createPod = stub(async () => {
        throw new Error('createPod should not have been called past the retry window')
      })
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: { findMany: findManyRounds, update },
          podRoundTarget: { findMany: findManyTargets },
        }),
        ptp: createFakePtpClient({ createPod }),
        tokenEncryptionKey: TOKEN_KEY,
        logger: { error: () => {} },
      }

      const result = await retryFailedFires(deps)

      expect(update.calls).toHaveLength(1)
      expect(result).toEqual([
        {
          podRoundId: 'round-1',
          setCode: 'JTL',
          organizerRoundNumber: 1,
          outcome: 'gave-up',
          originGuildName: null,
          targets: [{ channelId: 'channel-1', messageId: 'msg-1' }],
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a null thresholdReachedAt as immediately give-up-eligible (pre-migration data) rather than crashing', async () => {
    const round = fakeRoundWithOrganizer({
      id: 'round-1',
      setCode: 'JTL',
      status: 'THRESHOLD_REACHED',
      thresholdReachedAt: null,
      fireFailureNotified: false,
    })
    const findManyRounds = stubPodRoundFindMany(async () => [round])
    const update = stub(async (args: PodRoundUpdateArgs) => {
      const expected: PodRoundUpdateArgs = { where: { id: 'round-1' }, data: { fireFailureNotified: true } }
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakePodRoundRow({ fireFailureNotified: true })
    })
    const findManyTargets = stub(async () => [])
    const createPod = stub(async () => {
      throw new Error('createPod should not have been called for a null thresholdReachedAt')
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: { findMany: findManyRounds, update },
        podRoundTarget: { findMany: findManyTargets },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await retryFailedFires(deps)

    expect(update.calls).toHaveLength(1)
    expect(result).toEqual([
      {
        podRoundId: 'round-1',
        setCode: 'JTL',
        organizerRoundNumber: 1,
        outcome: 'gave-up',
        originGuildName: null,
        targets: [],
      },
    ])
  })
})
