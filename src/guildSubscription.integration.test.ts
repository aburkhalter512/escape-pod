import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createIntegrationPrisma, resetDb } from './testUtils/integrationDb.js'
import { createIntegrationBackend } from './testUtils/integrationBackend.js'

// /subscribe-guild, /unsubscribe-guild, and /allow-organizer's real
// business logic (services/guilds.ts), against real Postgres, driven
// entirely through BackendClient — the same interface those command
// handlers call in production. Covers the soft-delete + reactivation
// semantics (a real row delete is impossible: pod_round_targets' FK to
// guild_subscriptions is ON DELETE RESTRICT) that a fake Prisma client
// exercises but can't prove actually round-trips through a real unique
// constraint on guildId.
const prisma = createIntegrationPrisma()

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb(prisma)
})

describe('guild subscription lifecycle, end to end against real Postgres', () => {
  it('requires a channel the first time a guild subscribes', async () => {
    const backend = createIntegrationBackend(prisma)

    const result = await backend.subscribeGuild('guild-1', 'admin-1', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/channel is required/i)
  })

  it('subscribes with a channel, then reads current settings back on a bare call', async () => {
    const backend = createIntegrationBackend(prisma)

    const subscribed = await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-1' })
    expect(subscribed).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' } })

    // A bare call (no channelId/policy) is a read, not a write — same
    // settings come back, nothing changes.
    const readBack = await backend.subscribeGuild('guild-1', 'admin-1', {})
    expect(readBack).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' } })
  })

  it('reconfigures the broadcast channel and posting policy on an already-subscribed guild', async () => {
    const backend = createIntegrationBackend(prisma)

    await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-1' })
    const reconfigured = await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-2', policy: 'OPEN' })

    expect(reconfigured).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' } })
  })

  it('unsubscribe soft-deletes: listEligibleGuilds stops seeing it, a second unsubscribe is a no-op', async () => {
    const backend = createIntegrationBackend(prisma)

    await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-1', policy: 'OPEN' })
    const eligibleBefore = await backend.listEligibleGuilds('any-origin-guild')
    expect(eligibleBefore.guilds.map((g) => g.guildId)).toContain('guild-1')

    const firstUnsubscribe = await backend.unsubscribeGuild('guild-1')
    expect(firstUnsubscribe).toEqual({ wasSubscribed: true })

    const eligibleAfter = await backend.listEligibleGuilds('any-origin-guild')
    expect(eligibleAfter.guilds.map((g) => g.guildId)).not.toContain('guild-1')

    const secondUnsubscribe = await backend.unsubscribeGuild('guild-1')
    expect(secondUnsubscribe).toEqual({ wasSubscribed: false })

    // Unsubscribing a guild that was never subscribed at all is the same
    // no-op response, not an error.
    const neverSubscribed = await backend.unsubscribeGuild('guild-never-seen')
    expect(neverSubscribed).toEqual({ wasSubscribed: false })
  })

  it('resubscribing with a channel after unsubscribe clears the soft-delete and restores eligibility', async () => {
    const backend = createIntegrationBackend(prisma)

    await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-1', policy: 'OPEN' })
    await backend.unsubscribeGuild('guild-1')

    // Bare reactivation attempt (no channel) reports last-known settings
    // without writing anything or resurrecting the subscription.
    const bareAttempt = await backend.subscribeGuild('guild-1', 'admin-1', {})
    expect(bareAttempt).toEqual({ ok: true, value: { subscribed: false, broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' } })
    expect((await backend.listEligibleGuilds('any-origin-guild')).guilds.map((g) => g.guildId)).not.toContain('guild-1')

    const reactivated = await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-3' })
    expect(reactivated).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-3', postingPolicy: 'OPEN' } })

    const eligibleAfter = await backend.listEligibleGuilds('any-origin-guild')
    expect(eligibleAfter.guilds.map((g) => g.guildId)).toContain('guild-1')
  })

  it('ALLOWLIST policy has no eligible origin guilds by default', async () => {
    const backend = createIntegrationBackend(prisma)

    await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-1', policy: 'ALLOWLIST' })

    const eligible = await backend.listEligibleGuilds('origin-guild-1')
    expect(eligible).toEqual({ guilds: [], anySubscribed: true })
  })

  // Eligibility is now origin-guild-based (GuildOriginAllowlist, granted
  // via the /allow-guild command — see a follow-up integration test once
  // that command exists), not organizer-based — /allow-organizer is
  // deprecated and its write no longer has any effect on eligibility,
  // proven directly here rather than just asserted in a comment.
  it('allowOrganizer (deprecated) no longer has any effect on eligibility', async () => {
    const backend = createIntegrationBackend(prisma)

    await backend.subscribeGuild('guild-1', 'admin-1', { channelId: 'channel-1', policy: 'ALLOWLIST' })
    await backend.allowOrganizer('guild-1', 'organizer-1', 'admin-1')

    const eligible = await backend.listEligibleGuilds('origin-guild-1')
    expect(eligible.guilds.map((g) => g.guildId)).not.toContain('guild-1')
  })
})
