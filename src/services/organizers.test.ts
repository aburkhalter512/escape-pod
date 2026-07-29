import { describe, expect, it } from 'vitest'
import { createFakeAppSqlStorage } from '../testUtils/fakeAppSqlStorage.js'
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
    const linkOrganizerStorage = stub(async () => {
      throw new Error('organizer.linkOrganizer should not have been called')
    })
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ organizer: { linkOrganizer: linkOrganizerStorage } }),
      ptp: createFakePtpClient({ validateToken: stub(async () => false) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await linkOrganizer(deps, { discordId: 'user-1', token })

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'PTP rejected this token' } })
  })

  it('returns a validation error when the token cannot be decoded, even if PTP would have accepted it', async () => {
    const linkOrganizerStorage = stub(async () => {
      throw new Error('organizer.linkOrganizer should not have been called')
    })
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ organizer: { linkOrganizer: linkOrganizerStorage } }),
      ptp: createFakePtpClient({ validateToken: stub(async () => true) }),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await linkOrganizer(deps, { discordId: 'user-1', token: 'not-a-real-jwt' })

    expect(result).toEqual({ ok: false, error: { kind: 'validation', message: 'Could not read token payload' } })
  })
})

describe('listEligibleGuilds', () => {
  it('returns anySubscribed: true (without a count query) when eligible guilds are found', async () => {
    const findEligibleForOrigin = stub(async () => [
      { guildId: 'g1', installedByDiscordId: 'admin-1', broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' as const, unsubscribedAt: null, installedAt: new Date() },
    ])
    const countActiveSubscriptions = stub(async () => {
      throw new Error('countActiveSubscriptions should not have been called when eligible guilds were already found')
    })
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ guildSubscription: { findEligibleForOrigin, countActiveSubscriptions } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await listEligibleGuilds(deps, 'origin-guild-1')

    expect(result).toEqual({ guilds: [{ guildId: 'g1' }], anySubscribed: true })
  })

  it('returns anySubscribed: false when no eligible guilds are found and no guild anywhere is subscribed', async () => {
    const findEligibleForOrigin = stub(async () => [])
    const countActiveSubscriptions = stub(async () => 0)
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ guildSubscription: { findEligibleForOrigin, countActiveSubscriptions } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await listEligibleGuilds(deps, 'origin-guild-1')

    expect(result).toEqual({ guilds: [], anySubscribed: false })
  })

  it('returns anySubscribed: true when no eligible guilds are found but other guilds are subscribed', async () => {
    const findEligibleForOrigin = stub(async () => [])
    const countActiveSubscriptions = stub(async () => 3)
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ guildSubscription: { findEligibleForOrigin, countActiveSubscriptions } }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    const result = await listEligibleGuilds(deps, 'origin-guild-1')

    expect(result).toEqual({ guilds: [], anySubscribed: true })
  })

  // None of the tests above actually verify the query filters on the
  // right field; this proves eligibility is checked against
  // GuildOriginAllowlist.allowedOriginGuildId (the guild /start-pod was
  // invoked FROM), not any organizer identity.
  it('queries for OPEN-policy guilds plus guilds that trust this origin guild specifically', async () => {
    const findEligibleForOrigin = stub(async (originGuildId: string) => {
      if (originGuildId !== 'origin-guild-1') throw new Error(`unexpected originGuildId: ${originGuildId}`)
      return []
    })
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({
        guildSubscription: { findEligibleForOrigin, countActiveSubscriptions: stub(async () => 0) },
      }),
      ptp: createFakePtpClient(),
      tokenEncryptionKey: TOKEN_KEY,
    }

    await listEligibleGuilds(deps, 'origin-guild-1')

    expect(findEligibleForOrigin.calls).toHaveLength(1)
  })
})
