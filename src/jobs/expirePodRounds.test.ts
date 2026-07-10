import { describe, expect, it } from 'vitest'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { createFakeDiscordRest } from '../testUtils/fakeDiscordRest.js'
import { stub } from '../testUtils/stub.js'
import type { PodServiceDeps } from '../services/pods.js'
import { expireOverduePodRounds } from './expirePodRounds.js'

const TOKEN_KEY = '00'.repeat(32)

function fakePodRoundRow() {
  return {
    id: 'round-1',
    organizerDiscordId: 'organizer-1',
    setCode: 'JTL',
    threshold: 8,
    status: 'COLLECTING' as const,
    scheduledFor: new Date('2026-01-01T00:00:00Z'),
    ptpPodShareId: null,
    createdAt: new Date(),
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

    expect(result).toEqual({ expired: 0 })
  })

  it('expires an overdue round and edits every target with a recorded message id', async () => {
    const editMessage = stub(async (_channelId: string, _messageId: string, _body: unknown) => ({}) as never)
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stub(async () => [fakePodRoundRow()]),
          updateMany: stub(async () => ({ count: 1 })),
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

    expect(result).toEqual({ expired: 1 })
    expect(editMessage.calls).toHaveLength(1) // only the target with a messageId
    expect(editMessage.calls[0][0]).toBe('channel-1')
  })

  it('logs (not throws) when editing a message fails for one target', async () => {
    const editMessage = stub(async () => {
      throw new Error('Missing Access')
    })
    const errors: unknown[] = []
    const deps: PodServiceDeps = {
      prisma: createFakePrismaClient({
        podRound: {
          findMany: stub(async () => [fakePodRoundRow()]),
          updateMany: stub(async () => ({ count: 1 })),
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

    expect(result).toEqual({ expired: 1 })
    expect(errors).toHaveLength(1)
  })
})
