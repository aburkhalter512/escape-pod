import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RESTPatchAPIChannelMessageJSONBody,
  RESTPatchAPIChannelMessageResult,
  RESTPostAPIChannelMessageJSONBody,
} from 'discord-api-types/v10'
import { expireOverduePodRounds } from './jobs/expirePodRounds.js'
import { retryOverdueFailedFires } from './jobs/retryFailedFires.js'
import { POD_CAPACITY } from './podConfig.js'
import { createFakePtpClient } from './testUtils/fakePtpClient.js'
import { createFakeDiscordRest } from './testUtils/fakeDiscordRest.js'
import { stub } from './testUtils/stub.js'
import { createIntegrationPrisma, resetDb } from './testUtils/integrationDb.js'
import {
  createIntegrationBackend,
  createIntegrationPodServiceDeps,
  linkFakeOrganizer,
} from './testUtils/integrationBackend.js'

// Full pod-round lifecycle (COLLECTING -> THRESHOLD_REACHED -> POD_CREATED
// -> CONCLUDED, plus the CANCELLED/EXPIRED side branches and the
// fire-retry rainy-day path) exercised against real Postgres, going
// through the exact same entry points production actually calls:
// BackendClient for everything a slash command/component interaction
// triggers (signup, start, cancel, conclude — see backendClient.ts), and
// the periodic-sweep job wrappers (jobs/expirePodRounds.ts,
// jobs/retryFailedFires.ts) for the two things only a scheduled tick ever
// triggers, never a slash command. Discord itself is faked
// (testUtils/fakeDiscordRest.ts) — no real Discord API calls — but the
// real message-building/fan-out code in those job wrappers still runs, so
// the fake's call log is inspected instead of ever reading Prisma
// directly. No test in this file calls services/pods.ts or `prisma.*`
// directly for setup or assertions.
const prisma = createIntegrationPrisma()

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb(prisma)
})

afterEach(() => {
  vi.useRealTimers()
})

function succeedingPtp() {
  return createFakePtpClient({
    validateToken: async () => true,
    createPod: stub(async () => ({
      id: 'pod-1',
      shareId: 'share-1',
      shareUrl: 'https://example.com/pod-1',
      createdAt: new Date().toISOString(),
    })),
  })
}

// createFakeDiscordRest returns the DiscordRestClient interface type, which
// erases each stub's `.calls` log — so the individual stubs are kept and
// returned separately, alongside the constructed client, for assertions.
function noisyFakeDiscordRest() {
  const editMessage = stub(
    async (_channelId: string, _messageId: string, _body: RESTPatchAPIChannelMessageJSONBody) =>
      ({}) as RESTPatchAPIChannelMessageResult
  )
  const postMessage = stub(
    async (_channelId: string, _body: RESTPostAPIChannelMessageJSONBody) => ({}) as RESTPatchAPIChannelMessageResult
  )
  const createDmChannel = stub(async (userId: string) => ({ id: `dm-${userId}` }) as never)
  const discordRest = createFakeDiscordRest({ editMessage, postMessage, createDmChannel })
  return { discordRest, editMessage, postMessage, createDmChannel }
}

describe('pod round lifecycle, end to end against real Postgres', () => {
  it('creation -> fills to capacity -> fires -> concludes, and rejects a signup on the concluded round', async () => {
    const backend = createIntegrationBackend(prisma, succeedingPtp())
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })

    for (let i = 0; i < POD_CAPACITY - 1; i++) {
      const result = await backend.recordSignup(podRoundId, `player-${i}`, `Player${i}`, 'guild-1', 'in')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.full).toBe(false)
    }

    const firing = await backend.recordSignup(podRoundId, 'player-last', 'PlayerLast', 'guild-1', 'in')
    expect(firing.ok).toBe(true)
    if (firing.ok) {
      expect(firing.value.podCreated).toBe(true)
      expect(firing.value.shareUrl).toBe('https://example.com/pod-1')
    }

    const concludeResult = await backend.concludeActiveRound('organizer-1')
    expect(concludeResult.ok).toBe(true)

    // Rainy day: nothing in the codebase's Discord UI can produce a click
    // on a concluded round's message (buildConcludedPodMessage renders no
    // buttons at all), but BackendClient's recordSignup is still directly
    // reachable (e.g. the internal HTTP API), and must not silently
    // accept a signup against a round that's already over.
    const lateSignup = await backend.recordSignup(podRoundId, 'late-player', 'LatePlayer', 'guild-1', 'in')
    expect(lateSignup.ok).toBe(false)
    if (!lateSignup.ok) expect(lateSignup.error.message).toMatch(/already concluded/i)

    // A second conclude attempt is the only observable (through
    // BackendClient alone) proof the round really is CONCLUDED, not just
    // "the first conclude call reported success."
    const secondConclude = await backend.concludeActiveRound('organizer-1')
    expect(secondConclude.ok).toBe(false)
    if (!secondConclude.ok) expect(secondConclude.error.message).toMatch(/already been concluded/i)
  })

  it('rejects concluding a round that has not fired yet, leaving it still cancellable', async () => {
    const backend = createIntegrationBackend(prisma, succeedingPtp())
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })
    await backend.recordSignup(podRoundId, 'player-1', 'Player1', 'guild-1', 'in')

    const result = await backend.concludeActiveRound('organizer-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/hasn't fired yet/i)

    // Still COLLECTING, proven by the fact it's still cancellable.
    const cancelResult = await backend.cancelActiveRound('organizer-1')
    expect(cancelResult?.podRoundId).toBe(podRoundId)
  })

  it('cancellation before the table fills stops the round and rejects further signups', async () => {
    const backend = createIntegrationBackend(prisma, succeedingPtp())
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })
    await backend.recordSignup(podRoundId, 'player-1', 'Player1', 'guild-1', 'in')
    await backend.recordSignup(podRoundId, 'player-2', 'Player2', 'guild-1', 'in')

    const cancelResult = await backend.cancelActiveRound('organizer-1')
    expect(cancelResult?.podRoundId).toBe(podRoundId)

    const rejected = await backend.recordSignup(podRoundId, 'player-3', 'Player3', 'guild-1', 'in')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.message).toMatch(/cancelled/i)

    // A second cancel attempt finds nothing left to cancel — proof the
    // round is really gone from the "active" set, not just reported as
    // cancelled once.
    const secondCancel = await backend.cancelActiveRound('organizer-1')
    expect(secondCancel).toBeNull()
  })

  it("rejects a second organizer trying to cancel someone else's round, leaving it untouched", async () => {
    const backend = createIntegrationBackend(prisma, succeedingPtp())
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })

    // cancelActiveRound resolves the round from the *caller's own*
    // organizerDiscordId, so a different organizer with no round of their
    // own simply finds nothing to cancel — the original round is
    // untouched, not forbidden-but-visible.
    const result = await backend.cancelActiveRound('organizer-2')
    expect(result).toBeNull()

    // The original organizer can still cancel their own round — proof it
    // was left alone by the other organizer's failed attempt.
    const ownCancel = await backend.cancelActiveRound('organizer-1')
    expect(ownCancel?.podRoundId).toBe(podRoundId)
  })

  it('deadline sweep expires a round that never reached its minimum', async () => {
    const ptp = succeedingPtp()
    const backend = createIntegrationBackend(prisma, ptp)
    const { discordRest, editMessage } = noisyFakeDiscordRest()
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 4,
      guildIds: ['guild-1'],
      scheduledFor: new Date(Date.now() - 1000),
    })
    await backend.recordMessagePosted(podRoundId, 'guild-1', 'message-1')
    await backend.recordSignup(podRoundId, 'player-1', 'Player1', 'guild-1', 'in')

    const summary = await expireOverduePodRounds(createIntegrationPodServiceDeps(prisma, ptp), discordRest)
    expect(summary).toEqual({ expired: 1, fired: 0 })

    expect(editMessage.calls).toHaveLength(1)
    const [channelId, messageId, body] = editMessage.calls[0]
    expect(channelId).toBe('channel-1')
    expect(messageId).toBe('message-1')
    expect(body.embeds![0].title).toMatch(/Expired/)
    expect(body.embeds![0].title).toContain('#1')

    const rejected = await backend.recordSignup(podRoundId, 'player-2', 'Player2', 'guild-1', 'in')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.message).toMatch(/expired/i)
  })

  it('deadline sweep fires a round that met its minimum but not full capacity', async () => {
    const ptp = succeedingPtp()
    const backend = createIntegrationBackend(prisma, ptp)
    const { discordRest, editMessage } = noisyFakeDiscordRest()
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: 4,
      guildIds: ['guild-1'],
      scheduledFor: new Date(Date.now() - 1000),
    })
    await backend.recordMessagePosted(podRoundId, 'guild-1', 'message-1')
    for (let i = 0; i < 5; i++) {
      await backend.recordSignup(podRoundId, `player-${i}`, `Player${i}`, 'guild-1', 'in')
    }

    const summary = await expireOverduePodRounds(createIntegrationPodServiceDeps(prisma, ptp), discordRest)
    expect(summary).toEqual({ expired: 0, fired: 1 })

    expect(editMessage.calls).toHaveLength(1)
    const [, , body] = editMessage.calls[0]
    expect(body.embeds![0].title).toMatch(/Starting!/)
    expect(body.embeds![0].title).toContain('#1')

    const rejected = await backend.recordSignup(podRoundId, 'player-late', 'PlayerLate', 'guild-1', 'in')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.message).toMatch(/already started/i)
  })

  it('a fire that fails to create the PTP pod can be retried and later succeeds within the retry window', async () => {
    let attempts = 0
    const createPod = stub(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('PTP is down')
      return { id: 'pod-1', shareId: 'share-1', shareUrl: 'https://example.com/pod-1', createdAt: new Date().toISOString() }
    })
    const ptp = createFakePtpClient({ validateToken: async () => true, createPod })
    const backend = createIntegrationBackend(prisma, ptp)
    const { discordRest, editMessage } = noisyFakeDiscordRest()
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })
    await backend.recordMessagePosted(podRoundId, 'guild-1', 'message-1')
    for (let i = 0; i < POD_CAPACITY; i++) {
      await backend.recordSignup(podRoundId, `player-${i}`, `Player${i}`, 'guild-1', 'in')
    }

    // Still stuck at THRESHOLD_REACHED (proof: further signups are
    // rejected the same way a fired round's would be — recordSignup
    // treats THRESHOLD_REACHED and POD_CREATED identically).
    const stuckSignup = await backend.recordSignup(podRoundId, 'player-extra', 'PlayerExtra', 'guild-1', 'in')
    expect(stuckSignup.ok).toBe(false)

    const summary = await retryOverdueFailedFires(createIntegrationPodServiceDeps(prisma, ptp), discordRest)
    expect(summary).toEqual({ succeeded: 1, gaveUp: 0 })
    expect(attempts).toBe(2)

    expect(editMessage.calls).toHaveLength(1)
    const [, , body] = editMessage.calls[0]
    expect(body.embeds![0].title).toMatch(/Starting!/)
    expect(body.embeds![0].title).toContain('#1')

    // Now really POD_CREATED, not just THRESHOLD_REACHED — conclude
    // succeeds, which is only possible from POD_CREATED.
    const concludeResult = await backend.concludeActiveRound('organizer-1')
    expect(concludeResult.ok).toBe(true)
  })

  it('gives up after the retry window elapses, notifies once, and leaves the round cancellable rather than auto-cancelling it', async () => {
    const createPod = stub(async (): Promise<never> => {
      throw new Error('PTP is down')
    })
    const ptp = createFakePtpClient({ validateToken: async () => true, createPod })
    const backend = createIntegrationBackend(prisma, ptp)
    const { discordRest, editMessage } = noisyFakeDiscordRest()
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })
    await backend.recordMessagePosted(podRoundId, 'guild-1', 'message-1')
    for (let i = 0; i < POD_CAPACITY; i++) {
      await backend.recordSignup(podRoundId, `player-${i}`, `Player${i}`, 'guild-1', 'in')
    }
    expect(createPod.calls).toHaveLength(1)

    // Simulate 31 minutes having passed since the claim (RETRY_WINDOW_MS
    // is 30 minutes) by advancing the system clock rather than backdating
    // any column directly — retryFailedFires derives elapsed time from
    // Date.now() vs. the real thresholdReachedAt timestamp fireRound
    // already stamped above using real time.
    vi.useFakeTimers({ now: Date.now() + 31 * 60 * 1000 })

    const firstSweep = await retryOverdueFailedFires(createIntegrationPodServiceDeps(prisma, ptp), discordRest)
    expect(firstSweep).toEqual({ succeeded: 0, gaveUp: 1 })
    // Past the window — retryFailedFires must not attempt PTP again.
    expect(createPod.calls).toHaveLength(1)

    expect(editMessage.calls).toHaveLength(1)
    const [, , body] = editMessage.calls[0]
    expect(body.embeds![0].title).toMatch(/Failed/)
    expect(body.embeds![0].title).toContain('#1')

    // A later sweep tick must not re-notify for the same round.
    const secondSweep = await retryOverdueFailedFires(createIntegrationPodServiceDeps(prisma, ptp), discordRest)
    expect(secondSweep).toEqual({ succeeded: 0, gaveUp: 0 })
    expect(editMessage.calls).toHaveLength(1)

    vi.useRealTimers()

    // Deliberately not auto-cancelled — the organizer can still manually
    // cancel.
    const cancelResult = await backend.cancelActiveRound('organizer-1')
    expect(cancelResult?.podRoundId).toBe(podRoundId)
  })
})
