import { describe, expect, it } from 'vitest'
import { LocalBackendClient } from './backendClient.js'
import { createFakePrismaClient, type FakePrismaOverrides } from './testUtils/fakePrismaClient.js'
import { createFakePtpClient } from './testUtils/fakePtpClient.js'
import { stub } from './testUtils/stub.js'

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

    expect(result).toEqual([{ guildId: 'g1' }])
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

  it('delegates cancelPod to podRound.findUnique + update, throwing on a non-organizer requester', async () => {
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

    await expect(client({ podRound: { findUnique } }).cancelPod('round-1', 'someone-else')).rejects.toThrow()
  })
})
