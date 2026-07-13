import { describe, expect, it } from 'vitest'
import { LocalBackendClient } from './backendClient.js'
import { createFakePrismaClient, type FakePrismaOverrides } from './testUtils/fakePrismaClient.js'
import { createFakePtpClient } from './testUtils/fakePtpClient.js'
import { stub } from './testUtils/stub.js'
import type { OnFiringHook } from './services/pods.js'

const TOKEN_KEY = '00'.repeat(32)

function client(overrides: FakePrismaOverrides = {}) {
  return new LocalBackendClient({
    prisma: createFakePrismaClient(overrides),
    ptp: createFakePtpClient(),
    tokenEncryptionKey: TOKEN_KEY,
    logger: { error: () => {} },
  })
}

describe('LocalBackendClient', () => {
  it('delegates a first-time subscribeGuild to guildSubscription.create with the right args', async () => {
    const findUnique = stub(async (_args: unknown) => null)
    const create = stub(async (_args: unknown) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: null,
      installedAt: new Date(),
    }))

    await client({ guildSubscription: { findUnique, create } }).subscribeGuild('g1', 'admin-1', { channelId: 'channel-1' })

    expect(create.calls).toHaveLength(1)
    expect(create.calls[0][0]).toEqual({
      data: { guildId: 'g1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    })
  })

  it('delegates unsubscribeGuild to services/guilds.ts', async () => {
    const findUnique = stub(async (_args: unknown) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: null,
      installedAt: new Date(),
    }))
    const update = stub(async (_args: unknown) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: new Date(),
      installedAt: new Date(),
    }))

    const result = await client({ guildSubscription: { findUnique, update } }).unsubscribeGuild('g1')

    expect(result).toEqual({ wasSubscribed: true })
    expect(update.calls).toHaveLength(1)
  })

  it('delegates allowOrganizer to guildOrganizerAllowlist.upsert', async () => {
    const upsert = stub(async (_args: unknown) => ({
      guildId: 'g1',
      organizerDiscordId: 'org-1',
      approvedBy: 'admin-1',
      approvedAt: new Date(),
    }))

    await client({ guildOrganizerAllowlist: { upsert } }).allowOrganizer('g1', 'org-1', 'admin-1')

    expect(upsert.calls).toHaveLength(1)
  })

  it('delegates listEligibleGuilds to guildSubscription.findMany and maps the result', async () => {
    const findMany = stub(async (_args: unknown) => [
      {
        guildId: 'g1',
        installedByDiscordId: 'admin-1',
        broadcastChannelId: 'channel-1',
        postingPolicy: 'OPEN' as const,
        unsubscribedAt: null,
        installedAt: new Date(),
      },
    ])

    const result = await client({ guildSubscription: { findMany } }).listEligibleGuilds('org-1')

    expect(result).toEqual({ guilds: [{ guildId: 'g1' }], anySubscribed: true })
  })

  it('delegates startPod to podRound.create and guildSubscription.findMany', async () => {
    const findMany = stub(async (_args: unknown) => [
      {
        guildId: 'g1',
        installedByDiscordId: 'admin-1',
        broadcastChannelId: 'channel-1',
        postingPolicy: 'OPEN' as const,
        unsubscribedAt: null,
        installedAt: new Date(),
      },
    ])
    const create = stub(async (_args: unknown) => ({
      id: 'round-1',
      organizerDiscordId: 'org-1',
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      createdAt: new Date(),
    }))

    const result = await client({ guildSubscription: { findMany }, podRound: { create } }).startPod({
      organizerDiscordId: 'org-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: ['g1'],
    })

    expect(result).toEqual({ podRoundId: 'round-1', targets: [{ guildId: 'g1', channelId: 'channel-1' }] })
  })

  it('forwards originGuildId through startPod to podRound.create', async () => {
    const findMany = stub(async (_args: unknown) => [])
    const create = stub(async (args: { data: { originGuildId?: string | null } }) => {
      expect(args.data.originGuildId).toBe('guild-123')
      return {
        id: 'round-1',
        organizerDiscordId: 'org-1',
        setCode: 'JTL',
        threshold: 8,
        status: 'COLLECTING' as const,
        scheduledFor: null,
        ptpPodShareId: null,
        originGuildName: null,
        originGuildId: 'guild-123',
        createdAt: new Date(),
      }
    })

    const result = await client({ guildSubscription: { findMany }, podRound: { create } }).startPod({
      organizerDiscordId: 'org-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: [],
      originGuildId: 'guild-123',
    })

    expect(result.podRoundId).toBe('round-1')
    expect(create.calls).toHaveLength(1)
  })

  it('forwards onFiring through to podsService.recordSignup and threads chatUrl/signupDiscordIds back out', async () => {
    // podRound.findUnique here is generic in AppPrismaClient (called both
    // with and without `include: { organizer: true }` elsewhere), so a
    // small function wrapper is needed instead of a plain stub() — same
    // pattern as services/pods.test.ts and the cancelPod test below.
    const { encryptToken } = await import('./crypto/tokenCrypto.js')
    const TOKEN_KEY_LOCAL = '00'.repeat(32)
    function findUnique() {
      return Promise.resolve({
        id: 'round-1',
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        status: 'COLLECTING' as const,
        scheduledFor: null,
        ptpPodShareId: null,
        originGuildName: null,
        originGuildId: null,
        createdAt: new Date(),
        organizer: {
          discordId: 'organizer-1',
          username: 'OrganizerOne',
          encryptedToken: encryptToken('a-real-token', TOKEN_KEY_LOCAL),
          expiresAt: new Date(),
          linkedAt: new Date(),
        },
      }) as never
    }
    const upsert = stub(async (_args: unknown) => ({
      podRoundId: 'round-1',
      discordId: 'p8',
      usernameSnapshot: 'P8',
      sourceGuildId: 'g1',
      status: 'IN' as const,
      signedUpAt: new Date(),
    }))
    const count = stub(async (_args: unknown) => 8)
    const findManySignups = stub(async (_args: unknown) => [
      { podRoundId: 'round-1', discordId: 'p8', usernameSnapshot: 'P8', sourceGuildId: 'g1', status: 'IN' as const, signedUpAt: new Date() },
    ])
    const findManyTargets = stub(async (_args: unknown) => [])
    const updateMany = stub(async (_args: unknown) => ({ count: 1 }))
    const update = stub(async (_args: unknown) => ({
      id: 'round-1',
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 8,
      status: 'POD_CREATED' as const,
      scheduledFor: null,
      ptpPodShareId: 'share-1',
      originGuildName: null,
      originGuildId: null,
      createdAt: new Date(),
    }))
    const createPod = stub(async (_token: string, _params: unknown) => ({
      id: 'ptp-pod-1',
      shareId: 'share-1',
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      createdAt: '2026-01-01T00:00:00Z',
    }))

    const onFiring = stub(async (_ctx: Parameters<OnFiringHook>[0]) => ({
      channelId: 'chat-channel-1',
      chatUrl: 'https://discord.com/invite/abc123',
    }))

    const backendClient = new LocalBackendClient({
      prisma: createFakePrismaClient({
        podRound: { findUnique, updateMany, update },
        podRoundSignup: { upsert, count, findMany: findManySignups },
        podRoundTarget: { findMany: findManyTargets },
      }),
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY_LOCAL,
      logger: { error: () => {} },
    })

    const result = await backendClient.recordSignup('round-1', 'p8', 'P8', 'g1', 'in', onFiring)

    expect(onFiring.calls).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      podCreated: true,
      shareUrl: 'https://www.protectthepod.com/draft/share-1',
      chatUrl: 'https://discord.com/invite/abc123',
      chatChannelId: 'chat-channel-1',
      signupDiscordIds: ['p8'],
      scheduledFor: null,
    })
  })

  it('recordSignup works with onFiring omitted entirely (regression guard)', async () => {
    const { encryptToken } = await import('./crypto/tokenCrypto.js')
    const TOKEN_KEY_LOCAL = '00'.repeat(32)
    function findUnique() {
      return Promise.resolve({
        id: 'round-1',
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        status: 'COLLECTING' as const,
        scheduledFor: null,
        ptpPodShareId: null,
        originGuildName: null,
        originGuildId: null,
        createdAt: new Date(),
        organizer: {
          discordId: 'organizer-1',
          username: 'OrganizerOne',
          encryptedToken: encryptToken('a-real-token', TOKEN_KEY_LOCAL),
          expiresAt: new Date(),
          linkedAt: new Date(),
        },
      }) as never
    }
    const upsert = stub(async (_args: unknown) => ({
      podRoundId: 'round-1',
      discordId: 'p8',
      usernameSnapshot: 'P8',
      sourceGuildId: 'g1',
      status: 'IN' as const,
      signedUpAt: new Date(),
    }))
    const count = stub(async (_args: unknown) => 3) // below POD_CAPACITY — no fire, no findMany needed
    const findManyTargets = stub(async (_args: unknown) => [])

    const backendClient = new LocalBackendClient({
      prisma: createFakePrismaClient({
        podRound: { findUnique },
        podRoundSignup: { upsert, count },
        podRoundTarget: { findMany: findManyTargets },
      }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY_LOCAL,
      logger: { error: () => {} },
    })

    const result = await backendClient.recordSignup('round-1', 'p8', 'P8', 'g1', 'in')

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({ full: false, podCreated: false, chatUrl: undefined, scheduledFor: null })
  })

  it('delegates cancelPod to podRound.findUnique + update, returning a forbidden error for a non-organizer requester', async () => {
    // podRound.findUnique is generic in AppPrismaClient (called both with
    // and without `include: { organizer: true }` elsewhere), so a plain
    // stub() can't satisfy its type — a small generic wrapper is needed
    // instead (same pattern as services/pods.test.ts).
    function findUnique() {
      return Promise.resolve({
        id: 'round-1',
        organizerDiscordId: 'org-1',
        setCode: 'JTL',
        threshold: 8,
        status: 'COLLECTING' as const,
        scheduledFor: null,
        ptpPodShareId: null,
        createdAt: new Date(),
      }) as never
    }

    const result = await client({ podRound: { findUnique } }).cancelPod('round-1', 'someone-else')

    expect(result).toEqual({
      ok: false,
      error: { kind: 'forbidden', message: 'Only the organizer who started this round can cancel it' },
    })
  })
})
