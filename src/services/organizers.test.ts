import { describe, expect, it } from 'vitest'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { linkOrganizer, listEligibleGuilds, type OrganizerServiceDeps } from './organizers.js'

const TOKEN_KEY = '00'.repeat(32)

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`
}

const FUTURE_EXP = () => Math.floor(Date.now() / 1000) + 3600

describe('linkOrganizer', () => {
  it('returns a validation error when PTP does not accept the token, without storing anything', async () => {
    const token = fakeJwt({ discord_id: 'user-1', username: 'PlayerOne', exp: FUTURE_EXP() })
    const upsert = stub(async () => {
      throw new Error('organizer.upsert should not have been called')
    })
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ organizer: { upsert } }),
      ptp: createFakePtpClient({ validateToken: stub(async () => false) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await linkOrganizer(deps, { discordId: 'user-1', token })

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'PTP rejected this token' } })
  })

  it('returns a validation error when the token cannot be decoded, even if PTP would have accepted it', async () => {
    const upsert = stub(async () => {
      throw new Error('organizer.upsert should not have been called')
    })
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ organizer: { upsert } }),
      ptp: createFakePtpClient({ validateToken: stub(async () => true) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await linkOrganizer(deps, { discordId: 'user-1', token: 'not-a-real-jwt' })

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'Could not read token payload' } })
  })
})

describe('listEligibleGuilds', () => {
  it('returns anySubscribed: true (without a count query) when eligible guilds are found', async () => {
    const findMany = stub(async () => [
      { guildId: 'g1', installedByDiscordId: 'admin-1', broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' as const, unsubscribedAt: null, installedAt: new Date() },
    ])
    const count = stub(async () => {
      throw new Error('count should not have been called when eligible guilds were already found')
    })
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ guildSubscription: { findMany, count } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await listEligibleGuilds(deps, 'organizer-1')

    expect(result).toEqual({ guilds: [{ guildId: 'g1' }], anySubscribed: true })
  })

  it('returns anySubscribed: false when no eligible guilds are found and no guild anywhere is subscribed', async () => {
    const findMany = stub(async () => [])
    const count = stub(async () => 0)
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ guildSubscription: { findMany, count } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await listEligibleGuilds(deps, 'organizer-1')

    expect(result).toEqual({ guilds: [], anySubscribed: false })
  })

  it('returns anySubscribed: true when no eligible guilds are found but other guilds are subscribed', async () => {
    const findMany = stub(async () => [])
    const count = stub(async () => 3)
    const deps: OrganizerServiceDeps = {
      prisma: createFakePrismaClient({ guildSubscription: { findMany, count } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await listEligibleGuilds(deps, 'organizer-1')

    expect(result).toEqual({ guilds: [], anySubscribed: true })
  })
})
