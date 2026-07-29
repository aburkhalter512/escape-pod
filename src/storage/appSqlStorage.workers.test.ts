import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EscapePodDurableObject, Env } from '../durableObject.js'

declare module 'cloudflare:test' {
  // Cloudflare's own documented pattern for typing `env` in tests
  // (declaration merging onto ProvidedEnv) — the empty body is required
  // syntax, not an oversight.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

// Real DO SQLite storage via @cloudflare/vitest-pool-workers, not a
// mock — proves the actual SQL (RETURNING, ON CONFLICT, compare-and-swap
// UPDATE...WHERE, unique constraints) behaves as appSqlStorage.ts
// assumes. isolatedStorage (on by default) rolls storage back between
// tests, so a fresh DO id per describe block isn't needed for isolation,
// but using distinct ids keeps failures easy to attribute.
function getStub(name: string) {
  const id = env.ESCAPE_POD_DO.idFromName(name)
  return env.ESCAPE_POD_DO.get(id)
}

describe('organizer', () => {
  it('upsert creates, then updates on a second call with the same discordId', async () => {
    const stub = getStub('organizer-upsert')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const created = await instance.appStorage.organizer.upsert({
        where: { discordId: 'organizer-1' },
        create: { discordId: 'organizer-1', username: 'PlayerOne', encryptedToken: 'enc-1', expiresAt: new Date('2030-01-01') },
        update: { username: 'PlayerOne', encryptedToken: 'enc-1', expiresAt: new Date('2030-01-01') },
      })
      expect(created).toMatchObject({ discordId: 'organizer-1', username: 'PlayerOne', nextRoundNumber: 1 })
      expect(created.linkedAt).toBeInstanceOf(Date)

      const updated = await instance.appStorage.organizer.upsert({
        where: { discordId: 'organizer-1' },
        create: { discordId: 'organizer-1', username: 'stale', encryptedToken: 'enc-2', expiresAt: new Date('2030-02-01') },
        update: { username: 'PlayerOneRenamed', encryptedToken: 'enc-2', expiresAt: new Date('2030-02-01') },
      })
      expect(updated.username).toBe('PlayerOneRenamed')
      expect(updated.encryptedToken).toBe('enc-2')
    })
  })

  it('incrementNextRoundNumber atomically bumps the counter and returns the post-increment row', async () => {
    const stub = getStub('organizer-increment')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.organizer.upsert({
        where: { discordId: 'organizer-1' },
        create: { discordId: 'organizer-1', username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
        update: { username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
      })

      const first = await instance.appStorage.organizer.incrementNextRoundNumber({
        where: { discordId: 'organizer-1' },
        data: { increment: 1 },
      })
      expect(first.nextRoundNumber).toBe(2)

      const second = await instance.appStorage.organizer.incrementNextRoundNumber({
        where: { discordId: 'organizer-1' },
        data: { increment: 1 },
      })
      expect(second.nextRoundNumber).toBe(3)
    })
  })

  it('updateToken stores a freshly-rotated token and expiry', async () => {
    const stub = getStub('organizer-update-token')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.organizer.upsert({
        where: { discordId: 'organizer-1' },
        create: { discordId: 'organizer-1', username: 'x', encryptedToken: 'stale-enc', expiresAt: new Date('2030-01-01') },
        update: { username: 'x', encryptedToken: 'stale-enc', expiresAt: new Date('2030-01-01') },
      })

      const updated = await instance.appStorage.organizer.updateToken({
        where: { discordId: 'organizer-1' },
        data: { encryptedToken: 'fresh-enc', expiresAt: new Date('2030-02-01') },
      })
      expect(updated.encryptedToken).toBe('fresh-enc')
      expect(updated.expiresAt).toEqual(new Date('2030-02-01'))
    })
  })

  it('findMany filters by expiresAt < cutoff', async () => {
    const stub = getStub('organizer-findMany')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.organizer.upsert({
        where: { discordId: 'expiring-soon' },
        create: { discordId: 'expiring-soon', username: 'a', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
        update: { username: 'a', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
      })
      await instance.appStorage.organizer.upsert({
        where: { discordId: 'expiring-later' },
        create: { discordId: 'expiring-later', username: 'b', encryptedToken: 'enc', expiresAt: new Date('2031-01-01') },
        update: { username: 'b', encryptedToken: 'enc', expiresAt: new Date('2031-01-01') },
      })

      const expiring = await instance.appStorage.organizer.findMany({ where: { expiresAt: { lt: new Date('2030-06-01') } } })
      expect(expiring.map((o) => o.discordId)).toEqual(['expiring-soon'])
    })
  })
})

describe('guildSubscription', () => {
  it('create defaults postingPolicy to ALLOWLIST when omitted, findUnique reads it back', async () => {
    const stub = getStub('guild-create')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const created = await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })
      expect(created).toMatchObject({ guildId: 'guild-1', postingPolicy: 'ALLOWLIST', unsubscribedAt: null })

      const found = await instance.appStorage.guildSubscription.findUnique({ where: { guildId: 'guild-1' } })
      expect(found?.broadcastChannelId).toBe('channel-1')
    })
  })

  it('findUnique returns null for a guild that was never created', async () => {
    const stub = getStub('guild-not-found')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const found = await instance.appStorage.guildSubscription.findUnique({ where: { guildId: 'nope' } })
      expect(found).toBeNull()
    })
  })

  it('update supports partial field sets (channel-only, policy-only) without clobbering the other', async () => {
    const stub = getStub('guild-update')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })

      const channelOnly = await instance.appStorage.guildSubscription.update({
        where: { guildId: 'guild-1' },
        data: { broadcastChannelId: 'channel-2' },
      })
      expect(channelOnly).toMatchObject({ broadcastChannelId: 'channel-2', postingPolicy: 'ALLOWLIST' })

      const policyOnly = await instance.appStorage.guildSubscription.update({
        where: { guildId: 'guild-1' },
        data: { postingPolicy: 'OPEN' },
      })
      expect(policyOnly).toMatchObject({ broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' })
    })
  })

  it('findMany (guildId-in-list overload) only returns subscribed guilds from the given list', async () => {
    const stub = getStub('guild-findMany-in')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-2', broadcastChannelId: 'channel-2', installedByDiscordId: 'admin-1' },
      })

      const found = await instance.appStorage.guildSubscription.findMany({
        where: { guildId: { in: ['guild-1', 'guild-3'] }, unsubscribedAt: null },
      })
      expect(found.map((g) => g.guildId)).toEqual(['guild-1'])
    })
  })

  it('findMany (OPEN/trust OR-clause overload) matches OPEN policy or a specific origin-guild trust grant', async () => {
    const stub = getStub('guild-findMany-or')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'open-guild', broadcastChannelId: 'c1', installedByDiscordId: 'admin-1', postingPolicy: 'OPEN' },
      })
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'trusting-guild', broadcastChannelId: 'c2', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'untrusting-guild', broadcastChannelId: 'c3', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildOriginAllowlist.upsert({
        where: { guildId_allowedOriginGuildId: { guildId: 'trusting-guild', allowedOriginGuildId: 'origin-1' } },
        create: { guildId: 'trusting-guild', allowedOriginGuildId: 'origin-1', approvedBy: 'admin-1' },
        update: { approvedBy: 'admin-1' },
      })

      const eligible = await instance.appStorage.guildSubscription.findMany({
        where: {
          unsubscribedAt: null,
          OR: [{ postingPolicy: 'OPEN' }, { originAllowlist: { some: { allowedOriginGuildId: 'origin-1' } } }],
        },
      })
      expect(new Set(eligible.map((g) => g.guildId))).toEqual(new Set(['open-guild', 'trusting-guild']))
    })
  })

  it('count only counts still-subscribed guilds', async () => {
    const stub = getStub('guild-count')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-1', broadcastChannelId: 'c1', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-2', broadcastChannelId: 'c2', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.update({ where: { guildId: 'guild-2' }, data: { unsubscribedAt: new Date() } })

      const count = await instance.appStorage.guildSubscription.count({ where: { unsubscribedAt: null } })
      expect(count).toBe(1)
    })
  })
})

describe('guildOrganizerAllowlist / guildOriginAllowlist', () => {
  it('upsert is idempotent - re-running for the same key updates approvedBy instead of erroring', async () => {
    const stub = getStub('allowlists')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-1', broadcastChannelId: 'c1', installedByDiscordId: 'admin-1' },
      })

      await instance.appStorage.guildOrganizerAllowlist.upsert({
        where: { guildId_organizerDiscordId: { guildId: 'guild-1', organizerDiscordId: 'org-1' } },
        create: { guildId: 'guild-1', organizerDiscordId: 'org-1', approvedBy: 'admin-1' },
        update: { approvedBy: 'admin-1' },
      })
      const second = await instance.appStorage.guildOrganizerAllowlist.upsert({
        where: { guildId_organizerDiscordId: { guildId: 'guild-1', organizerDiscordId: 'org-1' } },
        create: { guildId: 'guild-1', organizerDiscordId: 'org-1', approvedBy: 'admin-2' },
        update: { approvedBy: 'admin-2' },
      })
      expect(second.approvedBy).toBe('admin-2')

      const origin = await instance.appStorage.guildOriginAllowlist.upsert({
        where: { guildId_allowedOriginGuildId: { guildId: 'guild-1', allowedOriginGuildId: 'origin-1' } },
        create: { guildId: 'guild-1', allowedOriginGuildId: 'origin-1', approvedBy: 'admin-1' },
        update: { approvedBy: 'admin-1' },
      })
      expect(origin).toMatchObject({ guildId: 'guild-1', allowedOriginGuildId: 'origin-1', approvedBy: 'admin-1' })
    })
  })
})

describe('podRound', () => {
  async function seedOrganizerAndGuild(instance: EscapePodDurableObject) {
    await instance.appStorage.organizer.upsert({
      where: { discordId: 'organizer-1' },
      create: { discordId: 'organizer-1', username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
      update: { username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
    })
    await instance.appStorage.guildSubscription.create({
      data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    })
  }

  it('create persists the round and its nested targets in one call', async () => {
    const stub = getStub('podround-create')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)

      const round = await instance.appStorage.podRound.create({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          targets: { create: [{ guildId: 'guild-1', channelId: 'channel-1' }] },
        },
      })
      expect(round).toMatchObject({ organizerDiscordId: 'organizer-1', setCode: 'SOR', status: 'COLLECTING' })

      const targets = await instance.appStorage.podRoundTarget.findMany({ where: { podRoundId: round.id } })
      expect(targets).toMatchObject([{ guildId: 'guild-1', channelId: 'channel-1', messageId: null }])
    })
  })

  it('findUnique with include: organizer attaches the related organizer row; without it, does not', async () => {
    const stub = getStub('podround-include')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const plain = await instance.appStorage.podRound.findUnique({ where: { id: round.id } })
      expect(plain).not.toHaveProperty('organizer')

      const withOrganizer = await instance.appStorage.podRound.findUnique({
        where: { id: round.id },
        include: { organizer: true },
      })
      expect(withOrganizer?.organizer.discordId).toBe('organizer-1')
    })
  })

  it('updateMany as compare-and-swap: only the first WHERE-matching caller wins, a second call on the same round sees count 0', async () => {
    const stub = getStub('podround-cas')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const firstClaim = await instance.appStorage.podRound.updateMany({
        where: { id: round.id, status: 'COLLECTING' },
        data: { status: 'THRESHOLD_REACHED', thresholdReachedAt: new Date() },
      })
      expect(firstClaim.count).toBe(1)

      // Same WHERE guard, but the round is no longer COLLECTING — this is
      // exactly the guard fireRound (services/pods.ts) relies on to make
      // sure only one caller ever wins the claim.
      const secondClaim = await instance.appStorage.podRound.updateMany({
        where: { id: round.id, status: 'COLLECTING' },
        data: { status: 'THRESHOLD_REACHED', thresholdReachedAt: new Date() },
      })
      expect(secondClaim.count).toBe(0)

      const final = await instance.appStorage.podRound.findUnique({ where: { id: round.id } })
      expect(final?.status).toBe('THRESHOLD_REACHED')
    })
  })

  it('the unique (organizerDiscordId, organizerRoundNumber) constraint throws catchably on a duplicate', async () => {
    const stub = getStub('podround-unique')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      await expect(
        instance.appStorage.podRound.create({
          data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SHD', threshold: 6, targets: { create: [] } },
        })
      ).rejects.toThrow()
    })
  })

  it('findFirst resolves an exact organizerRoundNumber, or falls back to the most recently created round', async () => {
    const stub = getStub('podround-findFirst')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })
      // createdAt has millisecond precision (same as the Postgres side's
      // TIMESTAMP(3), and this test's assertion depends on the two rows
      // sorting distinctly) — a real gap between creates, not a flaky
      // race on same-millisecond ordering.
      await new Promise((resolve) => setTimeout(resolve, 5))
      await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, setCode: 'SHD', threshold: 6, targets: { create: [] } },
      })

      const exact = await instance.appStorage.podRound.findFirst({
        where: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1 },
      })
      expect(exact?.setCode).toBe('SOR')

      const mostRecent = await instance.appStorage.podRound.findFirst({
        where: { organizerDiscordId: 'organizer-1' },
        orderBy: { createdAt: 'desc' },
      })
      expect(mostRecent?.setCode).toBe('SHD')
    })
  })

  it('findMany (organizerDiscordId+status-in overload) orders by organizerRoundNumber ascending', async () => {
    const stub = getStub('podround-findMany-statuses')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, setCode: 'SHD', threshold: 6, targets: { create: [] } },
      })
      await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const rounds = await instance.appStorage.podRound.findMany({
        where: { organizerDiscordId: 'organizer-1', status: { in: ['COLLECTING'] } },
        orderBy: { organizerRoundNumber: 'asc' },
      })
      expect(rounds.map((r) => r.organizerRoundNumber)).toEqual([1, 2])
    })
  })

  it('findMany (status+include overload) attaches organizer to every returned row', async () => {
    const stub = getStub('podround-findMany-include')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.create({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          scheduledFor: new Date('2020-01-01'),
          targets: { create: [] },
        },
      })

      const overdue = await instance.appStorage.podRound.findMany({
        where: { status: 'COLLECTING', scheduledFor: { lte: new Date() } },
        include: { organizer: true },
      })
      expect(overdue).toHaveLength(1)
      expect(overdue[0].organizer.discordId).toBe('organizer-1')
    })
  })

  it('update supports partial field sets (e.g. just status + ptpPodShareId)', async () => {
    const stub = getStub('podround-update')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.create({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const updated = await instance.appStorage.podRound.update({
        where: { id: round.id },
        data: { status: 'POD_CREATED', ptpPodShareId: 'share-1' },
      })
      expect(updated).toMatchObject({ status: 'POD_CREATED', ptpPodShareId: 'share-1' })
    })
  })
})

describe('podRoundTarget', () => {
  it('update sets messageId, findUnique reads it back by the composite key', async () => {
    const stub = getStub('podroundtarget')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.organizer.upsert({
        where: { discordId: 'organizer-1' },
        create: { discordId: 'organizer-1', username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
        update: { username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
      })
      await instance.appStorage.guildSubscription.create({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })
      const round = await instance.appStorage.podRound.create({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          targets: { create: [{ guildId: 'guild-1', channelId: 'channel-1' }] },
        },
      })

      await instance.appStorage.podRoundTarget.update({
        where: { podRoundId_guildId: { podRoundId: round.id, guildId: 'guild-1' } },
        data: { messageId: 'message-1' },
      })

      const target = await instance.appStorage.podRoundTarget.findUnique({
        where: { podRoundId_guildId: { podRoundId: round.id, guildId: 'guild-1' } },
      })
      expect(target?.messageId).toBe('message-1')
    })
  })
})

describe('podRoundSignup', () => {
  async function seedRound(instance: EscapePodDurableObject) {
    await instance.appStorage.organizer.upsert({
      where: { discordId: 'organizer-1' },
      create: { discordId: 'organizer-1', username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
      update: { username: 'x', encryptedToken: 'enc', expiresAt: new Date('2030-01-01') },
    })
    return instance.appStorage.podRound.create({
      data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
    })
  }

  it('upsert is idempotent per (podRoundId, discordId) - a second signup call updates status, not a duplicate row', async () => {
    const stub = getStub('signup-upsert')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const round = await seedRound(instance)

      await instance.appStorage.podRoundSignup.upsert({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-1' } },
        create: { podRoundId: round.id, discordId: 'player-1', usernameSnapshot: 'Player1', sourceGuildId: 'guild-1', status: 'IN' },
        update: { status: 'IN' },
      })
      await instance.appStorage.podRoundSignup.upsert({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-1' } },
        create: { podRoundId: round.id, discordId: 'player-1', usernameSnapshot: 'Player1', sourceGuildId: 'guild-1', status: 'LEFT' },
        update: { status: 'LEFT' },
      })

      const signups = await instance.appStorage.podRoundSignup.findMany({ where: { podRoundId: round.id, status: 'IN' } })
      expect(signups).toHaveLength(0)

      const count = await instance.appStorage.podRoundSignup.count({ where: { podRoundId: round.id, status: 'IN' } })
      expect(count).toBe(0)
    })
  })

  it('findMany/count only see status: IN signups', async () => {
    const stub = getStub('signup-count')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const round = await seedRound(instance)

      await instance.appStorage.podRoundSignup.upsert({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-1' } },
        create: { podRoundId: round.id, discordId: 'player-1', usernameSnapshot: 'Player1', sourceGuildId: 'guild-1', status: 'IN' },
        update: { status: 'IN' },
      })
      await instance.appStorage.podRoundSignup.upsert({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-2' } },
        create: { podRoundId: round.id, discordId: 'player-2', usernameSnapshot: 'Player2', sourceGuildId: 'guild-1', status: 'LEFT' },
        update: { status: 'LEFT' },
      })

      const count = await instance.appStorage.podRoundSignup.count({ where: { podRoundId: round.id, status: 'IN' } })
      expect(count).toBe(1)
      const signups = await instance.appStorage.podRoundSignup.findMany({ where: { podRoundId: round.id, status: 'IN' } })
      expect(signups.map((s) => s.discordId)).toEqual(['player-1'])
    })
  })
})
