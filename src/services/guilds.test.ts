import { describe, expect, it } from 'vitest'
import type { AppPrismaClient } from '../prismaClient.js'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { subscribeGuild, unsubscribeGuild, type GuildServiceDeps } from './guilds.js'

type GuildSubscriptionRow = Awaited<ReturnType<AppPrismaClient['guildSubscription']['create']>>
type GuildSubscriptionCreateArgs = Parameters<AppPrismaClient['guildSubscription']['create']>[0]
type GuildSubscriptionUpdateArgs = Parameters<AppPrismaClient['guildSubscription']['update']>[0]

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

function buildDeps(overrides: Parameters<typeof createFakePrismaClient>[0] = {}): GuildServiceDeps {
  return { prisma: createFakePrismaClient(overrides) }
}

describe('subscribeGuild', () => {
  it('returns a validation error (without writing anything) when a never-subscribed guild omits the channel', async () => {
    const findUnique = stub(async () => null)
    const create = stub(async () => {
      throw new Error('create should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, create } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation', message: 'A channel is required the first time this server subscribes.' },
    })
    expect(create.calls).toHaveLength(0)
  })

  it('creates a new subscription with the given channel, defaulting policy (schema default, not set explicitly)', async () => {
    const findUnique = stub(async () => null)
    const expected: GuildSubscriptionCreateArgs = {
      data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    }
    const create = stub(async (args: GuildSubscriptionCreateArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected create args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow()
    })
    const deps = buildDeps({ guildSubscription: { findUnique, create } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-1' })

    expect(result).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' } })
  })

  it('creates a new subscription with an explicit OPEN policy when given', async () => {
    const findUnique = stub(async () => null)
    const create = stub(async (args: GuildSubscriptionCreateArgs) => {
      expect(args.data).toMatchObject({ postingPolicy: 'OPEN' })
      return fakeGuildSubscriptionRow({ postingPolicy: 'OPEN' })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, create } })

    const result = await subscribeGuild(deps, {
      guildId: 'guild-1',
      installedBy: 'admin-1',
      channelId: 'channel-1',
      policy: 'OPEN',
    })

    expect(result.ok && result.value.postingPolicy).toBe('OPEN')
  })

  it('reads back current settings without writing anything when neither channel nor policy is given', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-9', postingPolicy: 'OPEN' }))
    const update = stub(async () => {
      throw new Error('update should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-9', postingPolicy: 'OPEN' } })
    expect(update.calls).toHaveLength(0)
  })

  it('updates only the channel when only a channel is given, leaving policy alone', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ postingPolicy: 'OPEN' }))
    const expected: GuildSubscriptionUpdateArgs = {
      where: { guildId: 'guild-1' },
      data: { broadcastChannelId: 'channel-2', unsubscribedAt: null },
    }
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-2' })

    expect(result).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' } })
  })

  it('updates only the policy when only a policy is given, leaving the channel alone', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-1' }))
    const expected: GuildSubscriptionUpdateArgs = {
      where: { guildId: 'guild-1' },
      data: { postingPolicy: 'OPEN' },
    }
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', policy: 'OPEN' })

    expect(result).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' } })
  })

  it('never includes installedByDiscordId in an update — set once at creation, not reassigned on reconfigure', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow())
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      expect(args.data).not.toHaveProperty('installedByDiscordId')
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2' })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'someone-else', channelId: 'channel-2' })

    expect(update.calls).toHaveLength(1)
  })

  it('reports last-known settings (subscribed: false), without writing anything, when unsubscribed and no channel is given', async () => {
    const findUnique = stub(async () =>
      fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-1', postingPolicy: 'OPEN', unsubscribedAt: new Date() })
    )
    const update = stub(async () => {
      throw new Error('update should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({ ok: true, value: { subscribed: false, broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' } })
    expect(update.calls).toHaveLength(0)
  })

  it('reactivates (clears unsubscribedAt) when a channel is given for a currently-unsubscribed guild', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ unsubscribedAt: new Date() }))
    const expected: GuildSubscriptionUpdateArgs = {
      where: { guildId: 'guild-1' },
      data: { broadcastChannelId: 'channel-3', unsubscribedAt: null },
    }
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-3', unsubscribedAt: null })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-3' })

    expect(result).toEqual({ ok: true, value: { subscribed: true, broadcastChannelId: 'channel-3', postingPolicy: 'ALLOWLIST' } })
  })

  it('does not reactivate on a policy-only call while unsubscribed (still reports subscribed: false)', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ unsubscribedAt: new Date() }))
    const update = stub(async () => {
      throw new Error('update should not have been called — policy alone must not reactivate')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', policy: 'OPEN' })

    expect(result.ok && result.value.subscribed).toBe(false)
    expect(update.calls).toHaveLength(0)
  })
})

describe('unsubscribeGuild', () => {
  it('sets unsubscribedAt and reports wasSubscribed: true for a currently-subscribed guild', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow())
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      expect(args.where).toEqual({ guildId: 'guild-1' })
      expect(args.data.unsubscribedAt).toBeInstanceOf(Date)
      return fakeGuildSubscriptionRow({ unsubscribedAt: new Date() })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await unsubscribeGuild(deps, 'guild-1')

    expect(result).toEqual({ wasSubscribed: true })
    expect(update.calls).toHaveLength(1)
  })

  it('reports wasSubscribed: false (no write) for a guild that was never subscribed', async () => {
    const findUnique = stub(async () => null)
    const update = stub(async () => {
      throw new Error('update should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await unsubscribeGuild(deps, 'guild-1')

    expect(result).toEqual({ wasSubscribed: false })
    expect(update.calls).toHaveLength(0)
  })

  it('reports wasSubscribed: false (no write) for a guild that is already unsubscribed', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ unsubscribedAt: new Date() }))
    const update = stub(async () => {
      throw new Error('update should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await unsubscribeGuild(deps, 'guild-1')

    expect(result).toEqual({ wasSubscribed: false })
    expect(update.calls).toHaveLength(0)
  })
})
