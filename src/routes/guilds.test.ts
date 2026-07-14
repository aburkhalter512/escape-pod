import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { zodValidatorCompiler } from '../validation.js'
import type { AppPrismaClient } from '../prismaClient.js'
import { createFakePrismaClient, type FakePrismaOverrides } from '../testUtils/fakePrismaClient.js'
import { stub } from '../testUtils/stub.js'
import { deepEqual } from '../testUtils/deepEqual.js'
import { registerGuildRoutes } from './guilds.js'

type GuildSubscriptionCreateArgs = Parameters<AppPrismaClient['guildSubscription']['create']>[0]
type GuildSubscriptionUpdateArgs = Parameters<AppPrismaClient['guildSubscription']['update']>[0]
type GuildSubscriptionRow = Awaited<ReturnType<AppPrismaClient['guildSubscription']['create']>>
type AllowlistUpsertArgs = Parameters<AppPrismaClient['guildOrganizerAllowlist']['upsert']>[0]
type AllowlistRow = Awaited<ReturnType<AppPrismaClient['guildOrganizerAllowlist']['upsert']>>
type OriginAllowlistUpsertArgs = Parameters<AppPrismaClient['guildOriginAllowlist']['upsert']>[0]
type OriginAllowlistRow = Awaited<ReturnType<AppPrismaClient['guildOriginAllowlist']['upsert']>>

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

function fakeAllowlistRow(overrides: Partial<AllowlistRow> = {}): AllowlistRow {
  return {
    guildId: 'guild-1',
    organizerDiscordId: 'organizer-1',
    approvedBy: 'admin-1',
    approvedAt: new Date(),
    ...overrides,
  }
}

function fakeOriginAllowlistRow(overrides: Partial<OriginAllowlistRow> = {}): OriginAllowlistRow {
  return {
    guildId: 'guild-1',
    allowedOriginGuildId: 'origin-guild-1',
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
  it('creates a new subscription with the given channel', async () => {
    const findUnique = stub(async (_args: unknown) => null)
    const expectedCreate: GuildSubscriptionCreateArgs = {
      data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    }
    const create = stub(async (args: GuildSubscriptionCreateArgs) => {
      if (!deepEqual(args, expectedCreate)) throw new Error(`unexpected create args: ${JSON.stringify(args)}`)
      return fakeGuildSubscriptionRow()
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, create } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-1', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' })
  })

  it('rejects a first-time subscribe with no channel (422), before touching create', async () => {
    const findUnique = stub(async (_args: unknown) => null)
    const create = stub(async (_args: unknown) => {
      throw new Error('create should not have been called')
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, create } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(422)
    expect(create.calls).toHaveLength(0)
  })

  it('reconfiguring (already-known guildId) only updates the given fields, not installedBy', async () => {
    // §7.2: installedByDiscordId should be set once at creation and not
    // silently change to whoever last ran /subscribe-guild — enforced by
    // update's data never including it.
    const findUnique = stub(async (_args: unknown) => fakeGuildSubscriptionRow())
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      expect(args.data).not.toHaveProperty('installedByDiscordId')
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2' })
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-2', installedBy: 'someone-else' },
    })

    expect(response.statusCode).toBe(200)
    expect(update.calls).toHaveLength(1)
  })

  it('reading current settings (no channel or policy given) does not write anything', async () => {
    const findUnique = stub(async (_args: unknown) => fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' }))
    const update = stub(async (_args: unknown) => {
      throw new Error('update should not have been called')
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ subscribed: true, broadcastChannelId: 'channel-1', postingPolicy: 'OPEN' })
    expect(update.calls).toHaveLength(0)
  })

  it('rejects a body missing a required field with 400, before touching prisma', async () => {
    const findUnique = stub(async (_args: unknown) => {
      throw new Error('findUnique should not have been called')
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-1' }, // no installedBy
    })

    expect(response.statusCode).toBe(400)
    expect(findUnique.calls).toHaveLength(0)
  })

  it('resubscribes (reactivates) a previously-unsubscribed guild when a channel is given', async () => {
    const findUnique = stub(async (_args: unknown) => fakeGuildSubscriptionRow({ unsubscribedAt: new Date() }))
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      expect(args.data).toEqual({ broadcastChannelId: 'channel-2', unsubscribedAt: null })
      return fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-2', unsubscribedAt: null })
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', channelId: 'channel-2', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ subscribed: true, broadcastChannelId: 'channel-2', postingPolicy: 'ALLOWLIST' })
  })

  it('reports subscribed: false (no write) for an unsubscribed guild when no channel is given', async () => {
    const findUnique = stub(async (_args: unknown) =>
      fakeGuildSubscriptionRow({ broadcastChannelId: 'channel-1', unsubscribedAt: new Date() })
    )
    const update = stub(async (_args: unknown) => {
      throw new Error('update should not have been called')
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/subscribe',
      payload: { guildId: 'guild-1', installedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ subscribed: false, broadcastChannelId: 'channel-1', postingPolicy: 'ALLOWLIST' })
    expect(update.calls).toHaveLength(0)
  })
})

describe('POST /guilds/unsubscribe', () => {
  it('unsubscribes a currently-subscribed guild', async () => {
    const findUnique = stub(async (_args: unknown) => fakeGuildSubscriptionRow())
    const update = stub(async (args: GuildSubscriptionUpdateArgs) => {
      expect(args.data.unsubscribedAt).toBeInstanceOf(Date)
      return fakeGuildSubscriptionRow({ unsubscribedAt: new Date() })
    })
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique, update } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/unsubscribe',
      payload: { guildId: 'guild-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ wasSubscribed: true })
  })

  it('reports wasSubscribed: false for a guild that was never subscribed', async () => {
    const findUnique = stub(async (_args: unknown) => null)
    const { app } = buildApp({ prisma: { guildSubscription: { findUnique } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/unsubscribe',
      payload: { guildId: 'guild-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ wasSubscribed: false })
  })

  it('rejects a body missing guildId with 400', async () => {
    const { app } = buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/unsubscribe',
      payload: {},
    })

    expect(response.statusCode).toBe(400)
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

describe('POST /guilds/allow-guild', () => {
  it('upserts the origin allowlist entry keyed by guildId+allowedOriginGuildId', async () => {
    const expectedArgs: OriginAllowlistUpsertArgs = {
      where: { guildId_allowedOriginGuildId: { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1' } },
      create: { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-1' },
      update: { approvedBy: 'admin-1' },
    }
    const upsert = stub(async (args: OriginAllowlistUpsertArgs) => {
      if (!deepEqual(args, expectedArgs)) throw new Error(`unexpected upsert args: ${JSON.stringify(args)}`)
      return fakeOriginAllowlistRow()
    })
    const { app } = buildApp({ prisma: { guildOriginAllowlist: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/allow-guild',
      payload: { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('re-granting trust updates who approved it most recently', async () => {
    const upsert = stub(async (_args: OriginAllowlistUpsertArgs) => fakeOriginAllowlistRow())
    const { app } = buildApp({ prisma: { guildOriginAllowlist: { upsert } } })

    await app.inject({
      method: 'POST',
      url: '/guilds/allow-guild',
      payload: { guildId: 'guild-1', allowedOriginGuildId: 'origin-guild-1', approvedBy: 'admin-2' },
    })

    expect(upsert.calls[0][0].update).toEqual({ approvedBy: 'admin-2' })
  })

  it('rejects a non-string allowedOriginGuildId with 400', async () => {
    const upsert = stub(async (_args: OriginAllowlistUpsertArgs) => fakeOriginAllowlistRow())
    const { app } = buildApp({ prisma: { guildOriginAllowlist: { upsert } } })

    const response = await app.inject({
      method: 'POST',
      url: '/guilds/allow-guild',
      payload: { guildId: 'guild-1', allowedOriginGuildId: 12345, approvedBy: 'admin-1' },
    })

    expect(response.statusCode).toBe(400)
    expect(upsert.calls).toHaveLength(0)
  })
})
