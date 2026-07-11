import { describe, expect, it } from 'vitest'
import type { AppPrismaClient } from '../prismaClient.js'
import { createFakePrismaClient } from '../testUtils/fakePrismaClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { ValidationError } from './errors.js'
import { subscribeGuild, type GuildServiceDeps } from './guilds.js'

type GuildSubscriptionRow = Awaited<ReturnType<AppPrismaClient['guildSubscription']['create']>>
type GuildSubscriptionCreateArgs = Parameters<AppPrismaClient['guildSubscription']['create']>[0]
type GuildSubscriptionUpdateArgs = Parameters<AppPrismaClient['guildSubscription']['update']>[0]

function fakeGuildSubscriptionRow(overrides: Partial<GuildSubscriptionRow> = {}): GuildSubscriptionRow {
  return {
    guildId: 'guild-1',
    installedByDiscordId: 'admin-1',
    broadcastChannelId: 'channel-1',
    postingPolicy: 'ALLOWLIST',
    installedAt: new Date(),
    ...overrides,
  }
}

function buildDeps(overrides: Parameters<typeof createFakePrismaClient>[0] = {}): GuildServiceDeps {
  return { prisma: createFakePrismaClient(overrides) }
}

describe('subscribeGuild', () => {
  it('throws ValidationError (without writing anything) when a never-subscribed guild omits the channel', async () => {
    const findUnique = stub(async () => null)
    const create = stub(async () => {
      throw new Error('create should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, create } })

    await expect(subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })).rejects.toBeInstanceOf(
      ValidationError
    )
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

    expect(result).toEqual({ broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' })
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

    expect(result.postingPolicy).toBe('OPEN')
  })

  it('reads back current settings without writing anything when neither channel nor policy is given', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-9', postingPolicy: 'OPEN' }))
    const update = stub(async () => {
      throw new Error('update should not have been called')
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1' })

    expect(result).toEqual({ broadcastChannelId: 'channel-9', postingPolicy: 'OPEN' })
    expect(update.calls).toHaveLength(0)
  })

  it('updates only the channel when only a channel is given, leaving policy alone', async () => {
    const findUnique = stub(async () => fakeGuildSubscriptionRow({ postingPolicy: 'OPEN' }))
    const expected: GuildSubscriptionUpdateArgs = {
      where: { guildId: 'guild-1' },
      data: { broadcastChannelId: 'channel-2' },
    }
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      if (!deepEqual(args, expected)) throw new Error(`unexpected update args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' })
    })
    const deps = buildDeps({ guildSubscription: { findUnique, update } })

    const result = await subscribeGuild(deps, { guildId: 'guild-1', installedBy: 'admin-1', channelId: 'channel-2' })

    expect(result).toEqual({ broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' })
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

    expect(result).toEqual({ broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' })
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
})
