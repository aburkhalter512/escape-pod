import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { stub } from '../testUtils/stub.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import type { PodServiceDeps } from '../services/pods.js'
import { retryOverdueFailedFires } from './retryFailedFires.js'

const TOKEN_KEY = '00'.repeat(32)
const NOW = new Date('2026-01-01T12:00:00Z')
const WITHIN_WINDOW = new Date(NOW.getTime() - 10 * 60 * 1000) // 10 min ago, < 30 min retry window
const PAST_WINDOW = new Date(NOW.getTime() - 31 * 60 * 1000) // 31 min ago, > 30 min retry window

// podRound.findMany is generic (see prismaClient.ts), so a plain fixed-return
// stub doesn't structurally satisfy it — mirrors expirePodRounds.test.ts's
// own stubPodRoundFindMany.
function stubPodRoundFindMany<Result>(impl: () => Promise<Result[]>) {
  function findMany<T extends Prisma.PodRoundFindManyArgs>(
    _args: Prisma.SelectSubset<T, Prisma.PodRoundFindManyArgs>
  ): Promise<Prisma.PodRoundGetPayload<T>[]> {
    return impl() as unknown as Promise<Prisma.PodRoundGetPayload<T>[]>
  }
  return findMany
}

function fakePodRoundRow(
  overrides: {
    threshold?: number
    originGuildName?: string | null
    chatChannelId?: string | null
    thresholdReachedAt?: Date | null
    fireFailureNotified?: boolean
  } = {}
) {
  return {
    id: 'round-1',
    organizerDiscordId: 'organizer-1',
    setCode: 'JTL',
    threshold: overrides.threshold ?? 8,
    status: 'THRESHOLD_REACHED' as const,
    scheduledFor: null,
    ptpPodShareId: null,
    originGuildName: overrides.originGuildName ?? null,
    originGuildId: null,
    chatChannelId: overrides.chatChannelId ?? null,
    thresholdReachedAt: overrides.thresholdReachedAt ?? WITHIN_WINDOW,
    fireFailureNotified: overrides.fireFailureNotified ?? false,
    createdAt: new Date(),
    organizer: {
      discordId: 'organizer-1',
      username: 'OrganizerOne',
      // Must be real ciphertext — attemptPodCreation actually decrypts this
      // before calling the stubbed createPod.
      encryptedToken: encryptToken('a-real-token', TOKEN_KEY),
      expiresAt: new Date(),
      linkedAt: new Date(),
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

describe('retryOverdueFailedFires', () => {
  it('does nothing (and calls no Discord API) when there is nothing to retry', async () => {
    const editMessage = stub(async () => {
      throw new Error('editMessage should not have been called')
    })
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({ podRound: { findMany: stub(async () => []) } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => {} },
    }

    const result = await retryOverdueFailedFires(deps, createFakeDiscordRest({ editMessage }))

    expect(result).toEqual({ succeeded: 0, gaveUp: 0 })
  })

  it('edits every target, DMs signed-up players, and posts the chat welcome message when a retry succeeds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
      const createInvite = stub(async () => ({ code: 'fresh123' }) as never)
      const createChannel = stub(async () => {
        throw new Error('createChannel should not have been called — retry only refreshes the invite')
      })
      const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
      const postMessage = stub(async (_channelId: string, _body: unknown) => ({}) as never)
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: {
            findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ chatChannelId: 'chat-channel-1' })]),
            update: stub(async () => fakePodRoundRow()),
          },
          podRoundSignup: {
            findMany: stub(async () => [
              fakePodRoundSignupRow({ discordId: 'p1' }),
              fakePodRoundSignupRow({ discordId: 'p2' }),
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

      const result = await retryOverdueFailedFires(
        deps,
        createFakeDiscordRest({ editMessage, createInvite, createChannel, createDmChannel, postMessage })
      )

      expect(result).toEqual({ succeeded: 1, gaveUp: 0 })
      expect(createChannel.calls).toHaveLength(0) // never recreates the channel
      expect(createInvite.calls).toEqual([['chat-channel-1']])

      expect(editMessage.calls).toHaveLength(1)
      expect(editMessage.calls[0][0]).toBe('channel-1')
      expect(editMessage.calls[0][2]).toMatchObject({
        components: [{ components: expect.arrayContaining([expect.objectContaining({ url: 'https://discord.com/invite/fresh123' })]) }],
      })

      expect(createDmChannel.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2'])

      const welcomeCall = postMessage.calls.find((c) => c[0] === 'chat-channel-1')
      expect(welcomeCall).toBeDefined()
      const content = (welcomeCall?.[1] as { content: string }).content
      expect(content).toContain('<@p1>')
      expect(content).toContain('<@p2>')
      expect(content).toContain('https://www.protectthepod.com/draft/share-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not request an invite or post a welcome message when the round has no chat channel', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const editMessage = stub(async () => ({}) as never)
      const createInvite = stub(async () => {
        throw new Error('createInvite should not have been called for a round with no chat channel')
      })
      const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
      const postMessage = stub(async () => {
        throw new Error('postMessage should not have been called for a round with no chat channel')
      })
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: {
            findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ chatChannelId: null })]),
            update: stub(async () => fakePodRoundRow()),
          },
          podRoundSignup: { findMany: stub(async () => [fakePodRoundSignupRow({ discordId: 'p1' })]) },
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

      const result = await retryOverdueFailedFires(deps, createFakeDiscordRest({ editMessage, createInvite, createDmChannel, postMessage }))

      expect(result).toEqual({ succeeded: 1, gaveUp: 0 })
      expect(createInvite.calls).toHaveLength(0)
      expect(createDmChannel.calls.map((c) => c[0])).toEqual(['p1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('edits every target to the failure message and sends no DM when a round gives up', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const editMessage = stub(async (_channelId: string, _messageId: string, body: { embeds: Array<{ description?: string }> }) => {
        expect(body.embeds[0].description).toContain('/cancel-pod')
        return {} as never
      })
      const createDmChannel = stub(async () => {
        throw new Error('createDmChannel should not have been called for a gave-up round')
      })
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: {
            findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ thresholdReachedAt: PAST_WINDOW })]),
            update: stub(async (args: unknown) => {
              expect(args).toEqual({ where: { id: 'round-1' }, data: { fireFailureNotified: true } })
              return fakePodRoundRow({ fireFailureNotified: true }) as never
            }),
          },
          podRoundTarget: {
            findMany: stub(async () => [
              { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
              { podRoundId: 'round-1', guildId: 'g2', channelId: 'channel-2', messageId: null, approvalStatus: null, postedAt: new Date() },
            ]),
          },
        }),
        ptp: createFakePtpClient({
          createPod: stub(async () => {
            throw new Error('createPod should not have been called past the retry window')
          }),
        }),
        tokenEncryptionKey: TOKEN_KEY,
        logger: { error: () => {} },
      }

      const result = await retryOverdueFailedFires(deps, createFakeDiscordRest({ editMessage, createDmChannel }))

      expect(result).toEqual({ succeeded: 0, gaveUp: 1 })
      expect(editMessage.calls).toHaveLength(1) // only the target with a messageId
      expect(editMessage.calls[0][0]).toBe('channel-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs (not throws) when editing a message fails for one target, and does not block the others', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      let call = 0
      const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => {
        call++
        if (call === 1) throw new Error('Missing Access')
        return {} as never
      })
      const errors: unknown[] = []
      const deps: PodServiceDeps = {
        prisma: createFakePrismaClient({
          podRound: {
            findMany: stubPodRoundFindMany(async () => [fakePodRoundRow({ thresholdReachedAt: PAST_WINDOW })]),
            update: stub(async () => fakePodRoundRow({ fireFailureNotified: true })),
          },
          podRoundTarget: {
            findMany: stub(async () => [
              { podRoundId: 'round-1', guildId: 'g1', channelId: 'channel-1', messageId: 'msg-1', approvalStatus: null, postedAt: new Date() },
              { podRoundId: 'round-1', guildId: 'g2', channelId: 'channel-2', messageId: 'msg-2', approvalStatus: null, postedAt: new Date() },
            ]),
          },
        }),
        ptp: createFakePtpClient(),
        tokenEncryptionKey: TOKEN_KEY,
        logger: { error: (obj) => errors.push(obj) },
      }

      const result = await retryOverdueFailedFires(deps, createFakeDiscordRest({ editMessage }))

      expect(result).toEqual({ succeeded: 0, gaveUp: 1 })
      expect(editMessage.calls).toHaveLength(2) // both targets attempted despite the first failing
      expect(errors).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
