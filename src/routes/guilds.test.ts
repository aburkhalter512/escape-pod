import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { zodValidatorCompiler } from '../validation.js'
import type { AppPrismaClient } from '../prismaClient.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { registerGuildRoutes } from './guilds.js'

type GuildSubscriptionUpsertArgs = Parameters<AppPrismaClient['guildSubscription']['upsert']>[0]
type GuildSubscriptionRow = Awaited<ReturnType<AppPrismaClient['guildSubscription']['upsert']>>
type AllowlistUpsertArgs = Parameters<AppPrismaClient['guildOrganizerAllowlist']['upsert']>[0]
type AllowlistRow = Awaited<ReturnType<AppPrismaClient['guildOrganizerAllowlist']['upsert']>>

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

function fakeAllowlistRow(overrides: Partial<AllowlistRow> = {}): AllowlistRow {
  return {
    guildId: 'guild-1',
    organizerDiscordId: 'organizer-1',
    approvedBy: 'admin-1',
    approvedAt: new Date(),
    ...overrides,
  }
}

function buildApp(overrides: { prisma?: FakePrismaOverrides } = {}) {
  const app = Fastify()
  app.setValidatorCompiler(zodValidatorCompiler)
  const prisma = createFakePrismaClient(overrides.prisma)

  registerGuildRoutes(app, { prisma })
  return { app, prisma }
}

describe('POST /guilds/subscribe', () => {
  it('upserts the subscription keyed by guildId', async () => {
    const expectedArgs: GuildSubscriptionUpsertArgs = {
      where: { guildId: 'guild-1' },
      create: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      update: { broadcastChannelId: 'channel-1' },
    }
    const upsert = stub(async (args: GuildSubscriptionUpsertArgs) => {
      if (!deepEqual(args, expectedArgs)) throw new Error(`unexpected upsert args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow()
    })
    const { app } = buildApp({ prisma: { guildSubscription: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-1', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('re-subscribing (already-known guildId) only updates the channel, not installedBy', async () => {
    // §7.2: installedByDiscordId should be set once at creation and not
    // silently change to whoever last ran /subscribe-guild. This is what
    // actually enforces that — Prisma's upsert applies `update` verbatim
    // on conflict, so `update` must not include installedByDiscordId.
    const upsert = stub(async (_args: GuildSubscriptionUpsertArgs) => fakeGuildSubscriptionRow())
    const { app } = buildApp({ prisma: { guildSubscription: { upsert } } })

    await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-2', installedBy: 'someone-else' },
    })

    expect(upsert.calls[0][0].update).not.toHaveProperty('installedByDiscordId')
  })

  it('rejects a body missing a required field with 400, before touching prisma', async () => {
    const upsert = stub(async (_args: GuildSubscriptionUpsertArgs) => fakeGuildSubscriptionRow())
    const { app } = buildApp({ prisma: { guildSubscription: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-1' }, // no installedBy
    })

    expect(response.statusCode).toBe(400)
    expect(upsert.calls).toHaveLength(0)
  })
})

describe('POST /guilds/allow-organizer', () => {
  it('upserts the allowlist entry keyed by guildId+organizerDiscordId', async () => {
    const expectedArgs: AllowlistUpsertArgs = {
      where: { guildId_organizerDiscordId: { guildId: 'guild-1', organizerDiscordId: 'organizer-1' } },
      create: { guildId: 'guild-1', organizerDiscordId: 'organizer-1', approvedBy: 'admin-1' },
      update: { approvedBy: 'admin-1' },
    }
    const upsert = stub(async (args: AllowlistUpsertArgs) => {
      if (!deepEqual(args, expectedArgs)) throw new Error(`unexpected upsert args: ${JSON.stringify(args)}`)
      return fakeAllowlistRow()
    })
    const { app } = buildApp({ prisma: { guildOrganizerAllowlist: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/allow-organizer',
      payload: { guildId: 'guild-1', organizerDiscordId: 'organizer-1', approvedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('re-approving updates who approved it most recently', async () => {
    const upsert = stub(async (_args: AllowlistUpsertArgs) => fakeAllowlistRow())
    const { app } = buildApp({ prisma: { guildOrganizerAllowlist: { upsert } } })

    await app.inject({
      method: 'POST',
      url: '/guilds/allow-organizer',
      payload: { guildId: 'guild-1', organizerDiscordId: 'organizer-1', approvedBy: 'admin-2' },
    })

    expect(upsert.calls[0][0].update).toEqual({ approvedBy: 'admin-2' })
  })

  it('rejects a non-string organizerDiscordId with 400', async () => {
    const upsert = stub(async (_args: AllowlistUpsertArgs) => fakeAllowlistRow())
    const { app } = buildApp({ prisma: { guildOrganizerAllowlist: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/allow-organizer',
      payload: { guildId: 'guild-1', organizerDiscordId: 12345, approvedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(400)
    expect(upsert.calls).toHaveLength(0)
  })
})
