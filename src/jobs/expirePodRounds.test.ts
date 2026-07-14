import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { stub } from '../testUtils/stub.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import type { PodServiceDeps } from '../services/pods.js'
import { expireOverduePodRounds } from './expirePodRounds.js'

const TOKEN_KEY = '00'.repeat(32)

// podRound.findMany is generic (see prismaClient.ts — same reasoning as
// findUnique there), so a plain fixed-return stub doesn't structurally
// satisfy it. Mirrors services/pods.test.ts's stubPodRoundFindMany.
function stubPodRoundFindMany<Result>(impl: () => Promise<Result[]>) {
  function findMany<T extends Prisma.PodRoundFindManyArgs>(
    _args: Prisma.SelectSubset<T, Prisma.PodRoundFindManyArgs>
  ): Promise<Prisma.PodRoundGetPayload<T>[]> {
    return impl() as unknown as Promise<Prisma.PodRoundGetPayload<T>[]>
  }
  return findMany
}

// podRound.findMany is always called with `include: { organizer: true }`
// (see prismaClient.ts) since a round that reached its threshold needs the
// organizer's token to fire — so every fixture here carries one, even
// though the expire-path tests below never actually read it.
function fakePodRoundRow(
  overrides: { threshold?: number; originGuildName?: string | null; originGuildId?: string | null } = {}
) {
  return {
    id: 'round-1',
    organizerDiscordId: 'organizer-1',
    organizerRoundNumber: 1,
    setCode: 'JTL',
    threshold: overrides.threshold ?? 8,
    status: 'COLLECTING' as const,
    scheduledFor: new Date('2026-01-01T00:00:00Z'),
    ptpPodShareId: null,
    originGuildName: overrides.originGuildName ?? null,
    originGuildId: overrides.originGuildId ?? null,
    chatChannelId: null,
    thresholdReachedAt: null,
    fireFailureNotified: false,
    createdAt: new Date(),
    organizer: {
      discordId: 'organizer-1',
      username: 'OrganizerOne',
      // Must be real ciphertext, not a placeholder — the fire-path test
      // actually decrypts this (fireRound -> decryptToken) before calling
      // the stubbed createPod, so a fake string would throw and silently
      // fail the fire (caught by fireRound's own try/catch).
      encryptedToken: encryptToken('a-real-token', TOKEN_KEY),
      expiresAt: new Date(),
      linkedAt: new Date(),
      nextRoundNumber: 2,
    },
  }
}

function fakePodRoundSignupRow(overrides: { discordId?: string } = {}) {
  return {
    podRoundId: 'round-1',
    discordId: overrides.discordId ?? 'player-1',
    usernameSnapshot: 'PlayerOne',
    sourceGuildId: 'g1',
    status: 'IN' as const,
    signedUpAt: new Date(),
  }
}

describe('expireOverduePodRounds', () => {
  it('does nothing (and calls no Discord API) when there is nothing overdue', async () => {
    const editMessage = stub(async () => {
      throw new Error('editMessage should not have been called')
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({ podRound: { findMany: stub(async () => []) } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverduePodRounds(deps, createFakeDiscordRest({ editMessage }))

    expect(result).toEqual({ expired: 0, fired: 0 })
  })

  it('expires an overdue round (below its own threshold) and edits every target with a recorded message id', async () => {
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 6 })]),
          updateMany: stub(async () => ({ count: 1 })),
        },
        // below threshold: 6 — count is derived from findMany's length,
        // not a separate .count() call.
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
            { podRoundId: 'round-1', guildId: 'g2', channelId: 'channel-2', messageId: null, approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverduePodRounds(deps, createFakeDiscordRest({ editMessage }))

    expect(result).toEqual({ expired: 1, fired: 0 })
    expect(editMessage.calls).toHaveLength(1) // only the target with a messageId
    expect(editMessage.calls[0][0]).toBe('channel-1')
  })

  it('fires (does not expire) an overdue round that reached its own threshold, short of a full table', async () => {
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 2 })]),
          updateMany: stub(async () => ({ count: 1 })),
          update: stub(async () => fakePodRoundRow()),
        },
        // >= threshold (2), short of POD_CAPACITY (8) — count is derived
        // from findMany's length, not a separate .count() call.
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
            fakePodRoundSignupRow({ discordId: 'p4' }),
            fakePodRoundSignupRow({ discordId: 'p5' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient({
        createPod: stub(async () => ({
          id: 'ptp-pod-1',
          shareId: 'share-1',
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          createdAt: '2026-01-01T00:00:00Z',
        })),
      }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverduePodRounds(deps, createFakeDiscordRest({ editMessage }))

    expect(result).toEqual({ expired: 0, fired: 1 })
    expect(editMessage.calls).toHaveLength(1)
  })

  it("carries the origin guild's name into both the expired and fired message bodies", async () => {
    const expiredEdit = stub(async (_channelId: string, _messageId: string, body: { embeds: Array<{ description?: string }> }) => {
      expect(body.embeds[0].description).toContain('Organizer: Expired-From Guild')
      return {} as never
    })
    const expiredDeps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 6, originGuildName: 'Expired-From Guild' })]),
          updateMany: stub(async () => ({ count: 1 })),
        },
        // below threshold: 6 — count is derived from findMany's length.
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }
    await expireOverduePodRounds(expiredDeps, createFakeDiscordRest({ editMessage: expiredEdit }))
    expect(expiredEdit.calls).toHaveLength(1)

    const firedEdit = stub(async (_channelId: string, _messageId: string, body: { embeds: Array<{ description?: string }> }) => {
      expect(body.embeds[0].description).toContain('Organizer: Fired-From Guild')
      return {} as never
    })
    const firedDeps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 2, originGuildName: 'Fired-From Guild' })]),
          updateMany: stub(async () => ({ count: 1 })),
          update: stub(async () => fakePodRoundRow()),
        },
        // >= threshold (2), short of POD_CAPACITY (8) — count is derived
        // from findMany's length.
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
            fakePodRoundSignupRow({ discordId: 'p4' }),
            fakePodRoundSignupRow({ discordId: 'p5' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient({
        createPod: stub(async () => ({
          id: 'ptp-pod-1',
          shareId: 'share-1',
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          createdAt: '2026-01-01T00:00:00Z',
        })),
      }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }
    await expireOverduePodRounds(firedDeps, createFakeDiscordRest({ editMessage: firedEdit }))
    expect(firedEdit.calls).toHaveLength(1)
  })

  it('includes a Players line with mentions for everyone signed up in the fired message body', async () => {
    const firedEdit = stub(async (_channelId: string, _messageId: string, body: { embeds: Array<{ description?: string }> }) => {
      expect(body.embeds[0].description).toContain('Players:\n- <@p1>\n- <@p2>\n- <@p3>\n- <@p4>\n- <@p5>')
      return {} as never
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 2 })]),
          updateMany: stub(async () => ({ count: 1 })),
          update: stub(async () => fakePodRoundRow()),
        },
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
            fakePodRoundSignupRow({ discordId: 'p4' }),
            fakePodRoundSignupRow({ discordId: 'p5' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient({
        createPod: stub(async () => ({
          id: 'ptp-pod-1',
          shareId: 'share-1',
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          createdAt: '2026-01-01T00:00:00Z',
        })),
      }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverduePodRounds(deps, createFakeDiscordRest({ editMessage: firedEdit }))

    expect(result).toEqual({ expired: 0, fired: 1 })
    expect(firedEdit.calls).toHaveLength(1)
  })

  it('creates a chat space in the origin guild and DMs every signed-up player when a round fires', async () => {
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const createChannel = stub(async (_guildId: string, _body: unknown) => ({ id: 'chat-channel-1' }) as never)
    const createInvite = stub(async () => ({ code: 'abc123' }) as never)
    const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
    const postMessage = stub(async (_channelId: string, _body: unknown) => ({}) as never)
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 2, originGuildId: 'origin-guild-1' })]),
          updateMany: stub(async () => ({ count: 1 })),
          update: stub(async () => fakePodRoundRow()),
        },
        // count is derived from this findMany's length, not a separate
        // .count() call — 2 rows still clears this round's threshold (2).
        podRoundSignup: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', discordId: 'p1', usernameSnapshot: 'P1', sourceGuildId: 'g1', status: 'IN' as const, signedUpAt: new Date() },
            { podRoundId: 'round-1', discordId: 'p2', usernameSnapshot: 'P2', sourceGuildId: 'g1', status: 'IN' as const, signedUpAt: new Date() },
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient({
        createPod: stub(async () => ({
          id: 'ptp-pod-1',
          shareId: 'share-1',
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          createdAt: '2026-01-01T00:00:00Z',
        })),
      }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverduePodRounds(
      deps,
      createFakeDiscordRest({ editMessage, createChannel, createInvite, createDmChannel, postMessage })
    )

    expect(result).toEqual({ expired: 0, fired: 1 })
    expect(createChannel.calls).toHaveLength(1)
    expect(createChannel.calls[0][0]).toBe('origin-guild-1')
    expect(createInvite.calls).toHaveLength(1)
    expect(createDmChannel.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2'])
    // The chat invite reaches the same body that got edited into every
    // target guild's message, not just the DMs.
    expect(editMessage.calls[0][2]).toMatchObject({
      components: [{ components: expect.arrayContaining([expect.objectContaining({ url: 'https://discord.com/invite/abc123' })]) }],
    })

    // The welcome message lands in the newly created chat channel — not a
    // DM channel — and mentions every signed-up player plus the real PTP
    // share URL (only known once ptp.createPod ran, after the channel was
    // created).
    const welcomeCall = postMessage.calls.find((c) => c[0] === 'chat-channel-1')
    expect(welcomeCall).toBeDefined()
    const content = (welcomeCall?.[1] as { content: string }).content
    expect(content).toContain('<@p1>')
    expect(content).toContain('<@p2>')
    expect(content).toContain('https://www.protectthepod.com/draft/share-1')
  })

  it('does not attempt a chat space for a round with no recorded origin guild, but still DMs signed-up players', async () => {
    const editMessage = stub(async () => ({}) as never)
    const createChannel = stub(async () => {
      throw new Error('createChannel should not have been called')
    })
    // DMs are not gated by origin guild (only the chat-space creation is)
    // — a round with no origin guild still notifies every signed-up player.
    const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
    const postMessage = stub(async (_channelId: string, _body: unknown) => ({}) as never)
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 2, originGuildId: null })]),
          updateMany: stub(async () => ({ count: 1 })),
          update: stub(async () => fakePodRoundRow()),
        },
        // >= threshold (2) — count is derived from this findMany's length.
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
            fakePodRoundSignupRow({ discordId: 'p4' }),
            fakePodRoundSignupRow({ discordId: 'p5' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient({
        createPod: stub(async () => ({
          id: 'ptp-pod-1',
          shareId: 'share-1',
          shareUrl: 'https://www.protectthepod.com/draft/share-1',
          createdAt: '2026-01-01T00:00:00Z',
        })),
      }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await expireOverduePodRounds(
      deps,
      createFakeDiscordRest({ editMessage, createChannel, createDmChannel, postMessage })
    )

    expect(result).toEqual({ expired: 0, fired: 1 })
    expect(createChannel.calls).toHaveLength(0)
    expect(createDmChannel.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('logs (not throws) when editing a message fails for one target', async () => {
    const editMessage = stub(async () => {
      throw new Error('Missing Access')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ threshold: 6 })]),
          updateMany: stub(async () => ({ count: 1 })),
        },
        // below threshold: 6 — count is derived from this findMany's
        // length, not a separate .count() call.
        podRoundSignup: {
          findMany: stub(async () => [
            fakePodRoundSignupRow({ discordId: 'p1' }),
            fakePodRoundSignupRow({ discordId: 'p2' }),
            fakePodRoundSignupRow({ discordId: 'p3' }),
          ]),
        },
        podRoundTarget: {
          findMany: stub(async () => [
            { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
          ]),
        },
      }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: (obj) => errors.push(obj) },
    }

    const result = await expireOverduePodRounds(deps, createFakeDiscordRest({ editMessage }))

    expect(result).toEqual({ expired: 1, fired: 0 })
    expect(errors).toHaveLength(1)
  })
})
