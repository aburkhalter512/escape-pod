import { describe, expect, it } from 'vitest'
import { LocalBackendClient } from './backendClient.js'
import { createFakeAppSqlStorage, type FakeAppStorageOverrides } from './testUtils/fakeAppSqlStorage.js'
import { createFakeNiamosClient } from './testUtils/fakeNiamosClient.js'
import { stub } from './testUtils/stub.js'
import type { OnFiringHook } from './services/pods.js'

const TOKEN_KEY = '00'.repeat(32)

function client(overrides: FakeAppStorageOverrides = {}) {
  return new LocalBackendClient({
    storage: createFakeAppSqlStorage(overrides),
    niamos: createFakeNiamosClient(),
    tokenEncryptionKey: TOKEN_KEY,
    logger: { error: () => {} },
  })
}

// startPod's atomic round-numbering claim reads the organizer row back via
// organizer.incrementNextRoundNumber — every startPod test needs this
// stubbed.
function stubOrganizerNextRoundNumber() {
  return stub(async (_args: unknown) => ({
    discordId: 'org-1',
    nextRoundNumber: 2,
  }))
}

describe('LocalBackendClient', () => {
  it('delegates a first-time subscribeGuild to guildSubscription.createSubscription with the right args', async () => {
    const findByGuildId = stub(async (_guildId: string) => null)
    const createSubscription = stub(async (_args: unknown) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: null,
      installedAt: new Date(),
    }))

    await client({ guildSubscription: { findByGuildId, createSubscription } }).subscribeGuild('g1', 'admin-1', {
      channelId: 'channel-1',
    })

    expect(createSubscription.calls).toHaveLength(1)
    expect(createSubscription.calls[0][0]).toEqual({
      data: { guildId: 'g1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    })
  })

  it('delegates unsubscribeGuild to services/guilds.ts', async () => {
    const findByGuildId = stub(async (_guildId: string) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: null,
      installedAt: new Date(),
    }))
    const markUnsubscribed = stub(async (_guildId: string) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: new Date(),
      installedAt: new Date(),
    }))

    const result = await client({ guildSubscription: { findByGuildId, markUnsubscribed } }).unsubscribeGuild('g1')

    expect(result).toEqual({ wasSubscribed: true })
    expect(markUnsubscribed.calls).toHaveLength(1)
  })

  it('delegates allowOrganizer to guildOrganizerAllowlist.approveOrganizer', async () => {
    const approveOrganizer = stub(async (_args: unknown) => ({
      guildId: 'g1',
      organizerDiscordId: 'org-1',
      approvedBy: 'admin-1',
      approvedAt: new Date(),
    }))

    await client({ guildOrganizerAllowlist: { approveOrganizer } }).allowOrganizer('g1', 'org-1', 'admin-1')

    expect(approveOrganizer.calls).toHaveLength(1)
  })

  it('delegates allowGuild to guildOriginAllowlist.approveOriginGuild', async () => {
    const approveOriginGuild = stub(async (_args: unknown) => ({
      guildId: 'g1',
      allowedOriginGuildId: 'origin-g1',
      approvedBy: 'admin-1',
      approvedAt: new Date(),
    }))
    const findByGuildId = stub(async (_guildId: string) => ({
      guildId: 'g1',
      installedByDiscordId: 'admin-1',
      broadcastChannelId: 'channel-1',
      postingPolicy: 'ALLOWLIST' as const,
      unsubscribedAt: null,
      installedAt: new Date(),
    }))

    const result = await client({
      guildSubscription: { findByGuildId },
      guildOriginAllowlist: { approveOriginGuild },
    }).allowGuild('g1', 'origin-g1', 'admin-1')

    expect(result).toEqual({ ok: true, value: undefined })
    expect(approveOriginGuild.calls).toHaveLength(1)
  })

  it('delegates listEligibleGuilds to guildSubscription.findEligibleForOrigin and maps the result', async () => {
    const findEligibleForOrigin = stub(async (_originGuildId: string) => [
      {
        guildId: 'g1',
        installedByDiscordId: 'admin-1',
        broadcastChannelId: 'channel-1',
        postingPolicy: 'OPEN' as const,
        unsubscribedAt: null,
        installedAt: new Date(),
      },
    ])

    const result = await client({ guildSubscription: { findEligibleForOrigin } }).listEligibleGuilds('org-1')

    expect(result).toEqual({ guilds: [{ guildId: 'g1' }], anySubscribed: true })
  })

  it('delegates startPod to podRound.createRoundWithTargets and guildSubscription.findActiveByGuildIds', async () => {
    const findActiveByGuildIds = stub(async (_guildIds: string[]) => [
      {
        guildId: 'g1',
        installedByDiscordId: 'admin-1',
        broadcastChannelId: 'channel-1',
        postingPolicy: 'OPEN' as const,
        unsubscribedAt: null,
        installedAt: new Date(),
      },
    ])
    const createRoundWithTargets = stub(async (_args: unknown) => ({
      id: 'round-1',
      organizerDiscordId: 'org-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      chatChannelId: null,
      thresholdReachedAt: null,
      fireFailureNotified: false,
      createdAt: new Date(),
    }))

    const result = await client({
      guildSubscription: { findActiveByGuildIds },
      podRound: { createRoundWithTargets },
      organizer: { incrementNextRoundNumber: stubOrganizerNextRoundNumber() },
    }).startPod({
      organizerDiscordId: 'org-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: ['g1'],
    })

    expect(result).toEqual({
      podRoundId: 'round-1',
      organizerRoundNumber: 1,
      targets: [{ guildId: 'g1', channelId: 'channel-1' }],
    })
  })

  it('forwards originGuildId through startPod to podRound.createRoundWithTargets', async () => {
    const findActiveByGuildIds = stub(async (_guildIds: string[]) => [])
    const createRoundWithTargets = stub(async (args: { data: { originGuildId?: string | null } }) => {
      expect(args.data.originGuildId).toBe('guild-123')
      return {
        id: 'round-1',
        organizerDiscordId: 'org-1',
        organizerRoundNumber: 1,
        setCode: 'JTL',
        threshold: 8,
        status: 'COLLECTING' as const,
        scheduledFor: null,
        ptpPodShareId: null,
        originGuildName: null,
        originGuildId: 'guild-123',
        chatChannelId: null,
        thresholdReachedAt: null,
        fireFailureNotified: false,
        createdAt: new Date(),
      }
    })

    const result = await client({
      guildSubscription: { findActiveByGuildIds },
      podRound: { createRoundWithTargets },
      organizer: { incrementNextRoundNumber: stubOrganizerNextRoundNumber() },
    }).startPod({
      organizerDiscordId: 'org-1',
      setCode: 'JTL',
      threshold: 8,
      guildIds: [],
      originGuildId: 'guild-123',
    })

    expect(result.podRoundId).toBe('round-1')
    expect(createRoundWithTargets.calls).toHaveLength(1)
  })

  it('forwards onFiring through to podsService.recordSignup and threads chatUrl/signupDiscordIds back out', async () => {
    const { encryptToken } = await import('./crypto/tokenCrypto.js')
    const TOKEN_KEY_LOCAL = '00'.repeat(32)
    const findRoundWithGuildTokenById = stub(async (_id: string) => ({
      id: 'round-1',
      organizerDiscordId: 'organizer-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      chatChannelId: null,
      thresholdReachedAt: null,
      fireFailureNotified: false,
      createdAt: new Date(),
      guildToken: {
        encryptedToken: encryptToken('a-real-token', TOKEN_KEY_LOCAL),
        displayName: 'Niamos',
      },
    }))
    const recordSignup = stub(async (_args: unknown) => ({
      podRoundId: 'round-1',
      discordId: 'p8',
      usernameSnapshot: 'P8',
      sourceGuildId: 'g1',
      status: 'IN' as const,
      signedUpAt: new Date(),
    }))
    // A full table (POD_CAPACITY: 8) — count is derived from this
    // findSignedUp's length, not a separate .count() call.
    const findSignedUp = stub(async (_podRoundId: string) =>
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((discordId) => ({
        podRoundId: 'round-1',
        discordId,
        usernameSnapshot: discordId,
        sourceGuildId: 'g1',
        status: 'IN' as const,
        signedUpAt: new Date(),
      }))
    )
    const findByRoundId = stub(async (_podRoundId: string) => [])
    const claimForFiring = stub(async (_id: string, _thresholdReachedAt: Date) => ({ count: 1 }))
    const markPodCreated = stub(async (_id: string, _data: unknown) => ({
      id: 'round-1',
      organizerDiscordId: 'organizer-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'POD_CREATED' as const,
      scheduledFor: null,
      ptpPodShareId: 'share-1',
      originGuildName: null,
      originGuildId: null,
      chatChannelId: 'chat-channel-1',
      thresholdReachedAt: new Date(),
      fireFailureNotified: false,
      createdAt: new Date(),
    }))
    const createDraft = stub(async (_token: string, _params: unknown) => ({
      uuid: 'share-1',
      shareUrl: 'https://niamos.net/drafts/share-1',
    }))

    const onFiring = stub(async (_ctx: Parameters<OnFiringHook>[0]) => ({
      channelId: 'chat-channel-1',
      chatUrl: 'https://discord.com/invite/abc123',
    }))

    const backendClient = new LocalBackendClient({
      storage: createFakeAppSqlStorage({
        podRound: { findRoundWithGuildTokenById, claimForFiring, markPodCreated },
        podRoundSignup: { recordSignup, findSignedUp },
        podRoundTarget: { findByRoundId },
      }),
      niamos: createFakeNiamosClient({ createDraft }),
      tokenEncryptionKey: TOKEN_KEY_LOCAL,
      logger: { error: () => {} },
    })

    const result = await backendClient.recordSignup('round-1', 'p8', 'P8', 'g1', 'in', onFiring)

    expect(onFiring.calls).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toMatchObject({
      podCreated: true,
      shareUrl: 'https://niamos.net/drafts/share-1',
      chatUrl: 'https://discord.com/invite/abc123',
      chatChannelId: 'chat-channel-1',
      signupDiscordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
      scheduledFor: null,
    })
  })

  it('recordSignup works with onFiring omitted entirely (regression guard)', async () => {
    const { encryptToken } = await import('./crypto/tokenCrypto.js')
    const TOKEN_KEY_LOCAL = '00'.repeat(32)
    const findRoundWithGuildTokenById = stub(async (_id: string) => ({
      id: 'round-1',
      organizerDiscordId: 'organizer-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      chatChannelId: null,
      thresholdReachedAt: null,
      fireFailureNotified: false,
      createdAt: new Date(),
      guildToken: {
        encryptedToken: encryptToken('a-real-token', TOKEN_KEY_LOCAL),
        displayName: 'Niamos',
      },
    }))
    const recordSignup = stub(async (_args: unknown) => ({
      podRoundId: 'round-1',
      discordId: 'p8',
      usernameSnapshot: 'P8',
      sourceGuildId: 'g1',
      status: 'IN' as const,
      signedUpAt: new Date(),
    }))
    // Below POD_CAPACITY — no fire, so fireRound's own separate findSignedUp
    // never runs; only recordSignup's own unconditional findSignedUp does.
    const findSignedUp = stub(async (_podRoundId: string) => [
      { podRoundId: 'round-1', discordId: 'p8', usernameSnapshot: 'P8', sourceGuildId: 'g1', status: 'IN' as const, signedUpAt: new Date() },
      { podRoundId: 'round-1', discordId: 'p9', usernameSnapshot: 'P9', sourceGuildId: 'g1', status: 'IN' as const, signedUpAt: new Date() },
      { podRoundId: 'round-1', discordId: 'p10', usernameSnapshot: 'P10', sourceGuildId: 'g1', status: 'IN' as const, signedUpAt: new Date() },
    ])
    const findByRoundId = stub(async (_podRoundId: string) => [])

    const backendClient = new LocalBackendClient({
      storage: createFakeAppSqlStorage({
        podRound: { findRoundWithGuildTokenById },
        podRoundSignup: { recordSignup, findSignedUp },
        podRoundTarget: { findByRoundId },
      }),
      niamos: createFakeNiamosClient(),
      tokenEncryptionKey: TOKEN_KEY_LOCAL,
      logger: { error: () => {} },
    })

    const result = await backendClient.recordSignup('round-1', 'p8', 'P8', 'g1', 'in')

    expect(result.ok).toBe(true)
    // Sorted by usernameSnapshot (alphabetical, not numeric) — "P10" sorts
    // before "P8"/"P9" as a string, which is exactly why this fixture uses
    // double-digit vs. single-digit usernames: it's the one test in this
    // file where the sort actually reorders something, rather than being a
    // stable no-op over identical/already-sorted usernames.
    expect(result.ok && result.value).toMatchObject({
      full: false,
      podCreated: false,
      chatUrl: undefined,
      scheduledFor: null,
      signupDiscordIds: ['p10', 'p8', 'p9'],
    })
  })

  it('delegates cancelPod to podRound.findRoundById, returning a forbidden error for a non-organizer requester', async () => {
    const findRoundById = stub(async (_id: string) => ({
      id: 'round-1',
      organizerDiscordId: 'org-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      chatChannelId: null,
      thresholdReachedAt: null,
      fireFailureNotified: false,
      createdAt: new Date(),
    }))

    const result = await client({ podRound: { findRoundById } }).cancelPod('round-1', 'someone-else')

    expect(result).toEqual({
      ok: false,
      error: { kind: 'forbidden', message: 'Only the organizer who started this round can cancel it' },
    })
  })

  it('delegates concludeActiveRound to podRound.findLatestRoundForOrganizer + findRoundById, returning a validation error for a non-concludable round', async () => {
    const findLatestRoundForOrganizer = stub(async (_organizerDiscordId: string) => ({
      id: 'round-1',
      organizerDiscordId: 'org-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      chatChannelId: null,
      thresholdReachedAt: null,
      fireFailureNotified: false,
      createdAt: new Date(),
    }))
    const findRoundById = stub(async (_id: string) => ({
      id: 'round-1',
      organizerDiscordId: 'org-1',
      organizerRoundNumber: 1,
      setCode: 'JTL',
      threshold: 8,
      status: 'COLLECTING' as const,
      scheduledFor: null,
      ptpPodShareId: null,
      originGuildName: null,
      originGuildId: null,
      chatChannelId: null,
      thresholdReachedAt: null,
      fireFailureNotified: false,
      createdAt: new Date(),
    }))

    const result = await client({ podRound: { findLatestRoundForOrganizer, findRoundById } }).concludeActiveRound('org-1')

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'validation',
        message: "This round hasn't fired yet — nothing to conclude. Did you mean `/cancel-pod`?",
      },
    })
  })
})
