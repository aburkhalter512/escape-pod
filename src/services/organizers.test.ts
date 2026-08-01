import { describe, expect, it } from 'vitest'
import { createFakeAppSqlStorage } from '../testUtils/fakeAppSqlStorage.js'
import { stub } from '../testUtils/stub.js'
import { listEligibleGuilds, type OrganizerServiceDeps } from './organizers.js'

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
    }

    const result = await listEligibleGuilds(deps, 'origin-guild-1')

    expect(result).toEqual({ guilds: [{ guildId: 'g1' }], anySubscribed: true })
  })

  it('returns anySubscribed: false when no eligible guilds are found and no guild anywhere is subscribed', async () => {
    const findEligibleForOrigin = stub(async () => [])
    const countActiveSubscriptions = stub(async () => 0)
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ guildSubscription: { findEligibleForOrigin, countActiveSubscriptions } }),
    }

    const result = await listEligibleGuilds(deps, 'origin-guild-1')

    expect(result).toEqual({ guilds: [], anySubscribed: false })
  })

  it('returns anySubscribed: true when no eligible guilds are found but other guilds are subscribed', async () => {
    const findEligibleForOrigin = stub(async () => [])
    const countActiveSubscriptions = stub(async () => 3)
    const deps: OrganizerServiceDeps = {
      storage: createFakeAppSqlStorage({ guildSubscription: { findEligibleForOrigin, countActiveSubscriptions } }),
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
    }

    await listEligibleGuilds(deps, 'origin-guild-1')

    expect(findEligibleForOrigin.calls).toHaveLength(1)
  })
})
