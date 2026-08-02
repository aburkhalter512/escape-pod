import { describe, expect, it } from 'vitest'
import type { AppStorage } from '../storage/appStorage.js'
import { createFakeAppSqlStorage } from '../testUtils/fakeAppSqlStorage.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { allowGuild, subscribeGuild, unsubscribeGuild, type GuildServiceDeps } from './guilds.js'

type GuildSubscriptionRow = Awaited<ReturnType<AppStorage['guildSubscription']['createSubscription']>>
type GuildSubscriptionCreateArgs = Parameters<AppStorage['guildSubscription']['createSubscription']>[0]
type GuildSubscriptionUpdateSettingsArgs = Parameters<AppStorage['guildSubscription']['updateSettings']>[0]
type OriginAllowlistApproveArgs = Parameters<AppStorage['guildOriginAllowlist']['approveOriginGuild']>[0]
type OriginAllowlistRow = Awaited<ReturnType<AppStorage['guildOriginAllowlist']['approveOriginGuild']>>

function fakeOriginAllowlistRow(overrides: Partial<OriginAllowlistRow> = {}): OriginAllowlistRow {
  return {
    guildId: 'guild-1',
    allowedOriginGuildId: 'origin-guild-1',
    approvedBy: 'admin-1',
    approvedAt: new Date(),
    ...overrides,
  }
}

function fakeGuildSubscriptionRow(overrides: Partial<GuildSubscriptionRow> = {}): GuildSubscriptionRow {
  return {
    guildId: 'guild-1',
    installedByDiscordId: 'admin-1',
    broadcastChannelId: 'channel-1',
    postingPolicy: 'ALLOWLIST',
    unsubscribedAt: null,
    installedAt: new Date(),
    ...overrides,
  }
}

function buildDeps(overrides: Parameters<typeof createFakeAppSqlStorage>[0] = {}): GuildServiceDeps {
  return { storage: createFakeAppSqlStorage(overrides) }
}

describe('subscribeGuild', () => {
  it('returns a validation error (without writing anything) when a never-subscribed guild omits the channel', async () => {
    const findByGuildId = stub(async () => null)
    const createSubscription = stub(async () => {
      throw new Error('createSubscription should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, createSubscription } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation', message: 'A channel is required the first time this server subscribes.' },
    })
    expect(createSubscription.calls).toHaveLength(0)
  })

  it('creates a new subscription with the given channel and reports isNewSubscription: true', async () => {
    const findByGuildId = stub(async () => null)
    const expected: GuildSubscriptionCreateArgs = {
      data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    }
    const createSubscription = stub(async (args: GuildSubscriptionCreateArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected createSubscription args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow()
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, createSubscription } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-1' })

    expect(result).toEqual({
      ok: true,
      value: { subscribed: true, broadcastChannelId: 'channel-1', isNewSubscription: true },
    })
  })

  it('reads back current settings (isNewSubscription: false) without writing anything when no channel is given', async () => {
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-9' }))
    const updateSettings = stub(async () => {
      throw new Error('updateSettings should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, updateSettings } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({
      ok: true,
      value: { subscribed: true, broadcastChannelId: 'channel-9', isNewSubscription: false },
    })
    expect(updateSettings.calls).toHaveLength(0)
  })

  it('updates the channel (isNewSubscription: false) when a channel is given for an already-subscribed guild', async () => {
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow())
    const expected: GuildSubscriptionUpdateSettingsArgs = {
      where: { guildId: 'guild-1' },
      data: { broadcastChannelId: 'channel-2', unsubscribedAt: null },
    }
    const updateSettings = stub(async (args: GuildSubscriptionUpdateSettingsArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected updateSettings args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2' })
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, updateSettings } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-2' })

    expect(result).toEqual({
      ok: true,
      value: { subscribed: true, broadcastChannelId: 'channel-2', isNewSubscription: false },
    })
  })

  it('never includes installedByDiscordId in an update — set once at creation, not reassigned on reconfigure', async () => {
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow())
    const updateSettings = stub(async (args: GuildSubscriptionUpdateSettingsArgs) => {
      expect(args.data).not.toHaveProperty('installedByDiscordId')
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2' })
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, updateSettings } })

    await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'someone-else', channelId: 'channel-2' })

    expect(updateSettings.calls).toHaveLength(1)
  })

  it('reports last-known settings (subscribed: false), without writing anything, when unsubscribed and no channel is given', async () => {
    const findByGuildId = stub(async () =>
      fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-1', unsubscribedAt: new Date() })
    )
    const updateSettings = stub(async () => {
      throw new Error('updateSettings should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, updateSettings } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({
      ok: true,
      value: { subscribed: false, broadcastChannelId: 'channel-1', isNewSubscription: false },
    })
    expect(updateSettings.calls).toHaveLength(0)
  })

  it('reactivates (clears unsubscribedAt, isNewSubscription: false) when a channel is given for a currently-unsubscribed guild', async () => {
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow({ unsubscribedAt: new Date() }))
    const expected: GuildSubscriptionUpdateSettingsArgs = {
      where: { guildId: 'guild-1' },
      data: { broadcastChannelId: 'channel-3', unsubscribedAt: null },
    }
    const updateSettings = stub(async (args: GuildSubscriptionUpdateSettingsArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected updateSettings args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-3', unsubscribedAt: null })
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, updateSettings } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-3' })

    expect(result).toEqual({
      ok: true,
      value: { subscribed: true, broadcastChannelId: 'channel-3', isNewSubscription: false },
    })
  })
})

describe('unsubscribeGuild', () => {
  it('sets unsubscribedAt and reports wasSubscribed: true for a currently-subscribed guild', async () => {
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow())
    const markUnsubscribed = stub(async (guildId: string) => {
      expect(guildId).toBe('guild-1')
      return fakeGuildSubscriptionRow({ unsubscribedAt: new Date() })
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, markUnsubscribed } })

    const result = await unsubscribeGuild(deps, 'guild-1')

    expect(result).toEqual({ wasSubscribed: true })
    expect(markUnsubscribed.calls).toHaveLength(1)
  })

  it('reports wasSubscribed: false (no write) for a guild that was never subscribed', async () => {
    const findByGuildId = stub(async () => null)
    const markUnsubscribed = stub(async () => {
      throw new Error('markUnsubscribed should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, markUnsubscribed } })

    const result = await unsubscribeGuild(deps, 'guild-1')

    expect(result).toEqual({ wasSubscribed: false })
    expect(markUnsubscribed.calls).toHaveLength(0)
  })

  it('reports wasSubscribed: false (no write) for a guild that is already unsubscribed', async () => {
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow({ unsubscribedAt: new Date() }))
    const markUnsubscribed = stub(async () => {
      throw new Error('markUnsubscribed should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId, markUnsubscribed } })

    const result = await unsubscribeGuild(deps, 'guild-1')

    expect(result).toEqual({ wasSubscribed: false })
    expect(markUnsubscribed.calls).toHaveLength(0)
  })
})

describe('allowGuild', () => {
  it('upserts the origin allowlist entry keyed by guildId+allowedOriginGuildId', async () => {
    const expected: OriginAllowlistApproveArgs = {
      where: { guildId_allowedOriginGuildId: { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1' } },
      create: { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-1' },
      update: { approvedBy: 'admin-1' },
    }
    const approveOriginGuild = stub(async (args: OriginAllowlistApproveArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected approveOriginGuild args: ${JSON.stringify(args)}`)
      return fakeOriginAllowlistRow()
    })
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow())
    const deps = buildDeps({ guildSubscription: { findByGuildId }, guildOriginAllowlist: { approveOriginGuild } })

    const result = await allowGuild(deps, { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-1' })

    expect(result).toEqual({ ok: true, value: undefined })
    expect(approveOriginGuild.calls).toHaveLength(1)
  })

  it('re-granting trust updates who approved it most recently, without changing the create shape', async () => {
    const approveOriginGuild = stub(async (_args: OriginAllowlistApproveArgs) => fakeOriginAllowlistRow())
    const findByGuildId = stub(async () => fakeGuildSubscriptionRow())
    const deps = buildDeps({ guildSubscription: { findByGuildId }, guildOriginAllowlist: { approveOriginGuild } })

    await allowGuild(deps, { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-2' })

    expect(approveOriginGuild.calls[0][0].update).toEqual({ approvedBy: 'admin-2' })
  })

  it("returns a validation error (without writing anything) when this guild hasn't run /escape-pod-setup", async () => {
    const findByGuildId = stub(async () => null)
    const approveOriginGuild = stub(async (_args: OriginAllowlistApproveArgs) => {
      throw new Error('approveOriginGuild should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findByGuildId }, guildOriginAllowlist: { approveOriginGuild } })

    const result = await allowGuild(deps, { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-1' })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation', message: 'This server needs to run /escape-pod-setup before it can trust other servers.' },
    })
    expect(approveOriginGuild.calls).toHaveLength(0)
  })
})
