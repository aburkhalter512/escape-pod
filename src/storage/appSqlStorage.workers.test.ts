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
  it('incrementNextRoundNumber creates the row on first use (starting at 1), then continues incrementing on later calls', async () => {
    // No separate linking step creates this row anymore (unlike PTP's old
    // per-organizer linkOrganizer) — the first /start-pod is what creates
    // it, via this same upsert.
    const stub = getStub('organizer-increment')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const first = await instance.appStorage.organizer.incrementNextRoundNumber({
        where: { discordId: 'organizer-1' },
        data: { increment: 1 },
      })
      expect(first).toEqual({ discordId: 'organizer-1', nextRoundNumber: 2 })

      const second = await instance.appStorage.organizer.incrementNextRoundNumber({
        where: { discordId: 'organizer-1' },
        data: { increment: 1 },
      })
      expect(second.nextRoundNumber).toBe(3)
    })
  })
})

describe('guildNiamosToken', () => {
  it('linkToken creates, then replaces the token on a second call with the same guildId', async () => {
    const stub = getStub('guild-niamos-token-link')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const created = await instance.appStorage.guildNiamosToken.linkToken({
        where: { guildId: 'guild-1' },
        create: { guildId: 'guild-1', encryptedToken: 'enc-1', linkedByDiscordId: 'admin-1', displayName: 'Niamos' },
        update: { encryptedToken: 'enc-1', linkedByDiscordId: 'admin-1', displayName: 'Niamos' },
      })
      expect(created).toMatchObject({ guildId: 'guild-1', encryptedToken: 'enc-1', linkedByDiscordId: 'admin-1', displayName: 'Niamos' })
      expect(created.linkedAt).toBeInstanceOf(Date)

      const updated = await instance.appStorage.guildNiamosToken.linkToken({
        where: { guildId: 'guild-1' },
        create: { guildId: 'guild-1', encryptedToken: 'stale', linkedByDiscordId: 'admin-1', displayName: 'stale' },
        update: { encryptedToken: 'enc-2', linkedByDiscordId: 'admin-2', displayName: 'NiamosRenamed' },
      })
      expect(updated).toMatchObject({ encryptedToken: 'enc-2', linkedByDiscordId: 'admin-2', displayName: 'NiamosRenamed' })
    })
  })
})

describe('guildSubscription', () => {
  it('createSubscription defaults postingPolicy to ALLOWLIST when omitted, findByGuildId reads it back', async () => {
    const stub = getStub('guild-create')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const created = await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })
      expect(created).toMatchObject({ guildId: 'guild-1', postingPolicy: 'ALLOWLIST', unsubscribedAt: null })

      const found = await instance.appStorage.guildSubscription.findByGuildId('guild-1')
      expect(found?.broadcastChannelId).toBe('channel-1')
    })
  })

  it('findByGuildId returns null for a guild that was never created', async () => {
    const stub = getStub('guild-not-found')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const found = await instance.appStorage.guildSubscription.findByGuildId('nope')
      expect(found).toBeNull()
    })
  })

  it('updateSettings supports partial field sets (channel-only, policy-only) without clobbering the other', async () => {
    const stub = getStub('guild-update')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })

      const channelOnly = await instance.appStorage.guildSubscription.updateSettings({
        where: { guildId: 'guild-1' },
        data: { broadcastChannelId: 'channel-2' },
      })
      expect(channelOnly).toMatchObject({ broadcastChannelId: 'channel-2', postingPolicy: 'ALLOWLIST' })

      const policyOnly = await instance.appStorage.guildSubscription.updateSettings({
        where: { guildId: 'guild-1' },
        data: { postingPolicy: 'OPEN' },
      })
      expect(policyOnly).toMatchObject({ broadcastChannelId: 'channel-2', postingPolicy: 'OPEN' })
    })
  })

  it('markUnsubscribed stamps unsubscribedAt', async () => {
    const stub = getStub('guild-unsubscribe')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })

      const unsubscribed = await instance.appStorage.guildSubscription.markUnsubscribed('guild-1')
      expect(unsubscribed.unsubscribedAt).toBeInstanceOf(Date)
    })
  })

  it('findActiveByGuildIds only returns subscribed guilds from the given list', async () => {
    const stub = getStub('guild-findActiveByGuildIds')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-2', broadcastChannelId: 'channel-2', installedByDiscordId: 'admin-1' },
      })

      const found = await instance.appStorage.guildSubscription.findActiveByGuildIds(['guild-1', 'guild-3'])
      expect(found.map((g) => g.guildId)).toEqual(['guild-1'])
    })
  })

  it('findActiveByGuildIds returns an empty array without querying when given no guild ids', async () => {
    const stub = getStub('guild-findActiveByGuildIds-empty')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const found = await instance.appStorage.guildSubscription.findActiveByGuildIds([])
      expect(found).toEqual([])
    })
  })

  it('findEligibleForOrigin matches OPEN policy or a specific origin-guild trust grant', async () => {
    const stub = getStub('guild-findEligibleForOrigin')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'open-guild', broadcastChannelId: 'c1', installedByDiscordId: 'admin-1', postingPolicy: 'OPEN' },
      })
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'trusting-guild', broadcastChannelId: 'c2', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'untrusting-guild', broadcastChannelId: 'c3', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildOriginAllowlist.approveOriginGuild({
        where: { guildId_allowedOriginGuildId: { guildId: 'trusting-guild', allowedOriginGuildId: 'origin-1' } },
        create: { guildId: 'trusting-guild', allowedOriginGuildId: 'origin-1', approvedBy: 'admin-1' },
        update: { approvedBy: 'admin-1' },
      })

      const eligible = await instance.appStorage.guildSubscription.findEligibleForOrigin('origin-1')
      expect(new Set(eligible.map((g) => g.guildId))).toEqual(new Set(['open-guild', 'trusting-guild']))
    })
  })

  it('countActiveSubscriptions only counts still-subscribed guilds', async () => {
    const stub = getStub('guild-count')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'c1', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-2', broadcastChannelId: 'c2', installedByDiscordId: 'admin-1' },
      })
      await instance.appStorage.guildSubscription.markUnsubscribed('guild-2')

      const count = await instance.appStorage.guildSubscription.countActiveSubscriptions()
      expect(count).toBe(1)
    })
  })
})

describe('guildOrganizerAllowlist / guildOriginAllowlist', () => {
  it('approveOrganizer/approveOriginGuild are idempotent - re-running for the same key updates approvedBy instead of erroring', async () => {
    const stub = getStub('allowlists')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'c1', installedByDiscordId: 'admin-1' },
      })

      await instance.appStorage.guildOrganizerAllowlist.approveOrganizer({
        where: { guildId_organizerDiscordId: { guildId: 'guild-1', organizerDiscordId: 'org-1' } },
        create: { guildId: 'guild-1', organizerDiscordId: 'org-1', approvedBy: 'admin-1' },
        update: { approvedBy: 'admin-1' },
      })
      const second = await instance.appStorage.guildOrganizerAllowlist.approveOrganizer({
        where: { guildId_organizerDiscordId: { guildId: 'guild-1', organizerDiscordId: 'org-1' } },
        create: { guildId: 'guild-1', organizerDiscordId: 'org-1', approvedBy: 'admin-2' },
        update: { approvedBy: 'admin-2' },
      })
      expect(second.approvedBy).toBe('admin-2')

      const origin = await instance.appStorage.guildOriginAllowlist.approveOriginGuild({
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
    // Creates the organizer row as a side effect (no separate linking step
    // exists anymore — see organizer.incrementNextRoundNumber's upsert)
    // so pod_rounds' FK to organizers(discord_id) is satisfiable;
    // increment: 0 is a test-only seeding trick, real callers always
    // increment by 1.
    await instance.appStorage.organizer.incrementNextRoundNumber({
      where: { discordId: 'organizer-1' },
      data: { increment: 0 },
    })
    await instance.appStorage.guildSubscription.createSubscription({
      data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
    })
  }

  async function seedGuildNiamosToken(instance: EscapePodDurableObject, guildId = 'guild-1') {
    await instance.appStorage.guildNiamosToken.linkToken({
      where: { guildId },
      create: { guildId, encryptedToken: 'enc-1', linkedByDiscordId: 'admin-1', displayName: 'Niamos' },
      update: { encryptedToken: 'enc-1', linkedByDiscordId: 'admin-1', displayName: 'Niamos' },
    })
  }

  it('createRoundWithTargets persists the round and its nested targets in one call', async () => {
    const stub = getStub('podround-create')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)

      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          targets: { create: [{ guildId: 'guild-1', channelId: 'channel-1' }] },
        },
      })
      expect(round).toMatchObject({ organizerDiscordId: 'organizer-1', setCode: 'SOR', status: 'COLLECTING' })

      const targets = await instance.appStorage.podRoundTarget.findByRoundId(round.id)
      expect(targets).toMatchObject([{ guildId: 'guild-1', channelId: 'channel-1', messageId: null }])
    })
  })

  it('findRoundWithGuildTokenById attaches the origin guild\'s linked Niamos token; findRoundById does not', async () => {
    const stub = getStub('podround-include')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await seedGuildNiamosToken(instance)
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          originGuildId: 'guild-1',
          targets: { create: [] },
        },
      })

      const plain = await instance.appStorage.podRound.findRoundById(round.id)
      expect(plain).not.toHaveProperty('guildToken')

      const withGuildToken = await instance.appStorage.podRound.findRoundWithGuildTokenById(round.id)
      expect(withGuildToken?.guildToken).toEqual({ encryptedToken: 'enc-1', displayName: 'Niamos' })
    })
  })

  it('findRoundWithGuildTokenById returns guildToken: null when the origin guild has no linked token', async () => {
    const stub = getStub('podround-include-no-token')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          originGuildId: 'guild-1',
          targets: { create: [] },
        },
      })

      const withGuildToken = await instance.appStorage.podRound.findRoundWithGuildTokenById(round.id)
      expect(withGuildToken?.guildToken).toBeNull()
    })
  })

  it('claimForFiring as compare-and-swap: only the first caller wins, a second call on the same round sees count 0', async () => {
    const stub = getStub('podround-cas-firing')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const firstClaim = await instance.appStorage.podRound.claimForFiring(round.id, new Date())
      expect(firstClaim.count).toBe(1)

      // Same WHERE guard, but the round is no longer COLLECTING — this is
      // exactly the guard fireRound (services/pods.ts) relies on to make
      // sure only one caller ever wins the claim.
      const secondClaim = await instance.appStorage.podRound.claimForFiring(round.id, new Date())
      expect(secondClaim.count).toBe(0)

      const final = await instance.appStorage.podRound.findRoundById(round.id)
      expect(final?.status).toBe('THRESHOLD_REACHED')
    })
  })

  it('claimExpired as compare-and-swap: only the first caller wins, a second call on the same round sees count 0', async () => {
    const stub = getStub('podround-cas-expired')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const firstClaim = await instance.appStorage.podRound.claimExpired(round.id)
      expect(firstClaim.count).toBe(1)

      const secondClaim = await instance.appStorage.podRound.claimExpired(round.id)
      expect(secondClaim.count).toBe(0)

      const final = await instance.appStorage.podRound.findRoundById(round.id)
      expect(final?.status).toBe('EXPIRED')
    })
  })

  it('the unique (organizerDiscordId, organizerRoundNumber) constraint throws catchably on a duplicate', async () => {
    const stub = getStub('podround-unique')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      await expect(
        instance.appStorage.podRound.createRoundWithTargets({
          data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SHD', threshold: 6, targets: { create: [] } },
        })
      ).rejects.toThrow()
    })
  })

  it('findRoundByOrganizerAndNumber resolves an exact round; findLatestRoundForOrganizer falls back to the most recently created one', async () => {
    const stub = getStub('podround-findFirst')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })
      // createdAt has millisecond precision (same as the Postgres side's
      // TIMESTAMP(3), and this test's assertion depends on the two rows
      // sorting distinctly) — a real gap between creates, not a flaky
      // race on same-millisecond ordering.
      await new Promise((resolve) => setTimeout(resolve, 5))
      await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, setCode: 'SHD', threshold: 6, targets: { create: [] } },
      })

      const exact = await instance.appStorage.podRound.findRoundByOrganizerAndNumber('organizer-1', 1)
      expect(exact?.setCode).toBe('SOR')

      const mostRecent = await instance.appStorage.podRound.findLatestRoundForOrganizer('organizer-1')
      expect(mostRecent?.setCode).toBe('SHD')
    })
  })

  it('findActiveRoundsForOrganizer orders by organizerRoundNumber ascending', async () => {
    const stub = getStub('podround-findActiveRoundsForOrganizer')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, setCode: 'SHD', threshold: 6, targets: { create: [] } },
      })
      await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const rounds = await instance.appStorage.podRound.findActiveRoundsForOrganizer('organizer-1', ['COLLECTING'])
      expect(rounds.map((r) => r.organizerRoundNumber)).toEqual([1, 2])
    })
  })

  it("findOverdueRounds attaches the origin guild's linked Niamos token to every returned row", async () => {
    const stub = getStub('podround-findOverdueRounds')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await seedGuildNiamosToken(instance)
      await instance.appStorage.podRound.createRoundWithTargets({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          scheduledFor: new Date('2020-01-01'),
          originGuildId: 'guild-1',
          targets: { create: [] },
        },
      })

      const overdue = await instance.appStorage.podRound.findOverdueRounds(new Date())
      expect(overdue).toHaveLength(1)
      expect(overdue[0].guildToken?.displayName).toBe('Niamos')
    })
  })

  it("findStuckThresholdReachedRounds attaches the origin guild's linked Niamos token to every returned row", async () => {
    const stub = getStub('podround-findStuckThresholdReachedRounds')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      await seedGuildNiamosToken(instance)
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          originGuildId: 'guild-1',
          targets: { create: [] },
        },
      })
      await instance.appStorage.podRound.claimForFiring(round.id, new Date())

      const stuck = await instance.appStorage.podRound.findStuckThresholdReachedRounds()
      expect(stuck).toHaveLength(1)
      expect(stuck[0].guildToken?.displayName).toBe('Niamos')
    })
  })

  it('markPodCreated supports an optional chatChannelId', async () => {
    const stub = getStub('podround-markPodCreated')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })

      const withoutChat = await instance.appStorage.podRound.markPodCreated(round.id, { ptpPodShareId: 'share-1' })
      expect(withoutChat).toMatchObject({ status: 'POD_CREATED', ptpPodShareId: 'share-1', chatChannelId: null })

      const withChat = await instance.appStorage.podRound.markPodCreated(round.id, {
        ptpPodShareId: 'share-2',
        chatChannelId: 'chat-1',
      })
      expect(withChat).toMatchObject({ ptpPodShareId: 'share-2', chatChannelId: 'chat-1' })
    })
  })

  it('markCancelled/markConcluded/markFireFailureNotified each set exactly their own field', async () => {
    const stub = getStub('podround-mark-transitions')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await seedOrganizerAndGuild(instance)
      const cancelled = await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })
      expect(await instance.appStorage.podRound.markCancelled(cancelled.id)).toMatchObject({ status: 'CANCELLED' })

      const concluded = await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 2, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })
      expect(await instance.appStorage.podRound.markConcluded(concluded.id)).toMatchObject({ status: 'CONCLUDED' })

      const notified = await instance.appStorage.podRound.createRoundWithTargets({
        data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 3, setCode: 'SOR', threshold: 6, targets: { create: [] } },
      })
      expect(await instance.appStorage.podRound.markFireFailureNotified(notified.id)).toMatchObject({
        fireFailureNotified: true,
        status: 'COLLECTING',
      })
    })
  })
})

describe('podRoundTarget', () => {
  it('setMessageId sets messageId, findByRoundAndGuild reads it back by the composite key', async () => {
    const stub = getStub('podroundtarget')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.organizer.incrementNextRoundNumber({
        where: { discordId: 'organizer-1' },
        data: { increment: 0 },
      })
      await instance.appStorage.guildSubscription.createSubscription({
        data: { guildId: 'guild-1', broadcastChannelId: 'channel-1', installedByDiscordId: 'admin-1' },
      })
      const round = await instance.appStorage.podRound.createRoundWithTargets({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'SOR',
          threshold: 6,
          targets: { create: [{ guildId: 'guild-1', channelId: 'channel-1' }] },
        },
      })

      await instance.appStorage.podRoundTarget.setMessageId(round.id, 'guild-1', 'message-1')

      const target = await instance.appStorage.podRoundTarget.findByRoundAndGuild(round.id, 'guild-1')
      expect(target?.messageId).toBe('message-1')
    })
  })
})

describe('podRoundSignup', () => {
  async function seedRound(instance: EscapePodDurableObject) {
    await instance.appStorage.organizer.incrementNextRoundNumber({
      where: { discordId: 'organizer-1' },
      data: { increment: 0 },
    })
    return instance.appStorage.podRound.createRoundWithTargets({
      data: { organizerDiscordId: 'organizer-1', organizerRoundNumber: 1, setCode: 'SOR', threshold: 6, targets: { create: [] } },
    })
  }

  it('recordSignup is idempotent per (podRoundId, discordId) - a second signup call updates status, not a duplicate row', async () => {
    const stub = getStub('signup-record')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const round = await seedRound(instance)

      await instance.appStorage.podRoundSignup.recordSignup({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-1' } },
        create: { podRoundId: round.id, discordId: 'player-1', usernameSnapshot: 'Player1', sourceGuildId: 'guild-1', status: 'IN' },
        update: { status: 'IN' },
      })
      await instance.appStorage.podRoundSignup.recordSignup({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-1' } },
        create: { podRoundId: round.id, discordId: 'player-1', usernameSnapshot: 'Player1', sourceGuildId: 'guild-1', status: 'LEFT' },
        update: { status: 'LEFT' },
      })

      const signups = await instance.appStorage.podRoundSignup.findSignedUp(round.id)
      expect(signups).toHaveLength(0)

      const count = await instance.appStorage.podRoundSignup.countSignedUp(round.id)
      expect(count).toBe(0)
    })
  })

  it('findSignedUp/countSignedUp only see status: IN signups', async () => {
    const stub = getStub('signup-count')
    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const round = await seedRound(instance)

      await instance.appStorage.podRoundSignup.recordSignup({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-1' } },
        create: { podRoundId: round.id, discordId: 'player-1', usernameSnapshot: 'Player1', sourceGuildId: 'guild-1', status: 'IN' },
        update: { status: 'IN' },
      })
      await instance.appStorage.podRoundSignup.recordSignup({
        where: { podRoundId_discordId: { podRoundId: round.id, discordId: 'player-2' } },
        create: { podRoundId: round.id, discordId: 'player-2', usernameSnapshot: 'Player2', sourceGuildId: 'guild-1', status: 'LEFT' },
        update: { status: 'LEFT' },
      })

      const count = await instance.appStorage.podRoundSignup.countSignedUp(round.id)
      expect(count).toBe(1)
      const signups = await instance.appStorage.podRoundSignup.findSignedUp(round.id)
      expect(signups.map((s) => s.discordId)).toEqual(['player-1'])
    })
  })
})
