import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelActiveRound,
  concludeActiveRound,
  concludePod,
  expireOverdueRounds,
  recordSignup,
  retryFailedFires,
  startPod,
  type PodServiceDeps,
} from './pods.js'
import { POD_CAPACITY } from '../podConfig.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { createIntegrationPrisma, resetDb } from '../testUtils/integrationDb.js'

// Full pod-round lifecycle (COLLECTING -> THRESHOLD_REACHED ->
// POD_CREATED -> CONCLUDED, plus the CANCELLED/EXPIRED side branches and
// the fire-retry rainy-day path) exercised against real Postgres, going
// through the exact same services/pods.ts functions the Discord command
// handlers and periodic sweeps call in production — no HTTP layer here,
// since /conclude-pod has no HTTP route at all (commands/concludePod.ts
// calls concludeActiveRound directly, in-process, same as every other
// command handler); the HTTP internal API (app.integration.test.ts) is a
// separate, narrower concern about request/response wiring, not this
// state machine.
const TOKEN_KEY = '22'.repeat(32)
const NO_LOGGER = { error: () => undefined }

const prisma = createIntegrationPrisma()

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb(prisma)
})

let organizerCounter = 0
let guildCounter = 0

// Each call gets its own organizer + subscribed guild so tests can run
// fully independent lifecycles without colliding on ids.
async function seedOrganizerAndGuild(): Promise<{ organizerDiscordId: string; guildId: string }> {
  organizerCounter += 1
  guildCounter += 1
  const organizerDiscordId = `organizer-${organizerCounter}`
  const guildId = `guild-${guildCounter}`

  await prisma.organizer.create({
    data: {
      discordId: organizerDiscordId,
      username: `Organizer${organizerCounter}`,
      encryptedToken: encryptToken('a-real-token', TOKEN_KEY),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
  await prisma.guildSubscription.create({
    data: { guildId, installedByDiscordId: organizerDiscordId, broadcastChannelId: `channel-${guildCounter}` },
  })

  return { organizerDiscordId, guildId }
}

async function signUp(deps: PodServiceDeps, podRoundId: string, discordId: string, guildId: string) {
  return recordSignup(deps, { podRoundId, discordId, username: discordId, sourceGuildId: guildId, action: 'in' })
}

function succeedingPtp() {
  return createFakePtpClient({
    createPod: stub(async () => ({
      id: 'pod-1',
      shareId: 'share-1',
      shareUrl: 'https://example.com/pod-1',
      createdAt: new Date().toISOString(),
    })),
  })
}

describe('pod round lifecycle, end to end against real Postgres', () => {
  it('creation -> fills to capacity -> fires -> concludes, and rejects a signup on the concluded round', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })

    for (let i = 0; i < POD_CAPACITY - 1; i++) {
      const result = await signUp(deps, podRoundId, `player-${i}`, guildId)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.full).toBe(false)
    }

    const firing = await signUp(deps, podRoundId, 'player-last', guildId)
    expect(firing.ok).toBe(true)
    if (firing.ok) {
      expect(firing.value.podCreated).toBe(true)
      expect(firing.value.shareUrl).toBe('https://example.com/pod-1')
    }

    const fired = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(fired.status).toBe('POD_CREATED')

    const concludeResult = await concludeActiveRound(deps, organizerDiscordId)
    expect(concludeResult.ok).toBe(true)

    const concluded = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(concluded.status).toBe('CONCLUDED')

    // Rainy day: nothing in the codebase's Discord UI can produce a click
    // on a concluded round's message (buildConcludedPodMessage renders no
    // buttons at all), but the service function itself is still reachable
    // directly (e.g. the internal HTTP API) and must not silently accept
    // a signup against a round that's already over.
    const lateSignup = await signUp(deps, podRoundId, 'late-player', guildId)
    expect(lateSignup.ok).toBe(false)
    if (!lateSignup.ok) expect(lateSignup.error.kind).toBe('validation')

    const signupRow = await prisma.podRoundSignup.findUnique({
      where: { podRoundId_discordId: { podRoundId, discordId: 'late-player' } },
    })
    expect(signupRow).toBeNull()
  })

  it('rejects concluding a round that has not fired yet', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })
    await signUp(deps, podRoundId, 'player-1', guildId)

    const result = await concludeActiveRound(deps, organizerDiscordId)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')

    const round = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(round.status).toBe('COLLECTING')
  })

  it('cancellation before the table fills stops the round and rejects further signups', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })
    await signUp(deps, podRoundId, 'player-1', guildId)
    await signUp(deps, podRoundId, 'player-2', guildId)

    const cancelResult = await cancelActiveRound(deps, organizerDiscordId)
    expect(cancelResult?.podRoundId).toBe(podRoundId)

    const cancelled = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(cancelled.status).toBe('CANCELLED')

    const rejected = await signUp(deps, podRoundId, 'player-3', guildId)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.message).toMatch(/cancelled/i)

    // The signups already recorded before cancellation are left alone —
    // cancellation is a status transition, not a data wipe.
    const signups = await prisma.podRoundSignup.findMany({ where: { podRoundId } })
    expect(signups).toHaveLength(2)
  })

  it('rejects a second organizer trying to cancel someone else\'s round', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const { organizerDiscordId: otherOrganizerId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })

    // cancelActiveRound resolves the round from the *caller's own*
    // organizerDiscordId, so a different organizer with no round of their
    // own simply finds nothing to cancel — the original round is
    // untouched, not forbidden-but-visible.
    const result = await cancelActiveRound(deps, otherOrganizerId)
    expect(result).toBeNull()

    const round = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(round.status).toBe('COLLECTING')
  })

  it('deadline sweep expires a round that never reached its minimum', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: 4,
      guildIds: [guildId],
      scheduledFor: new Date(Date.now() - 1000),
    })
    await signUp(deps, podRoundId, 'player-1', guildId)

    const results = await expireOverdueRounds(deps)
    const thisRound = results.find((r) => r.podRoundId === podRoundId)
    expect(thisRound?.outcome).toBe('expired')

    const expired = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(expired.status).toBe('EXPIRED')

    const rejected = await signUp(deps, podRoundId, 'player-2', guildId)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.message).toMatch(/expired/i)
  })

  it('deadline sweep fires a round that met its minimum but not full capacity', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: 4,
      guildIds: [guildId],
      scheduledFor: new Date(Date.now() - 1000),
    })
    for (let i = 0; i < 5; i++) {
      await signUp(deps, podRoundId, `player-${i}`, guildId)
    }

    const results = await expireOverdueRounds(deps)
    const thisRound = results.find((r) => r.podRoundId === podRoundId)
    expect(thisRound?.outcome).toBe('fired')
    if (thisRound?.outcome === 'fired') {
      expect(thisRound.count).toBe(5)
      expect(thisRound.shareUrl).toBe('https://example.com/pod-1')
    }

    const fired = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(fired.status).toBe('POD_CREATED')
  })

  it('a fire that fails to create the PTP pod can be retried and later succeeds within the retry window', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    let attempts = 0
    const createPod = stub(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('PTP is down')
      return { id: 'pod-1', shareId: 'share-1', shareUrl: 'https://example.com/pod-1', createdAt: new Date().toISOString() }
    })
    const deps: PodServiceDeps = {
      prisma,
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: NO_LOGGER,
    }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })
    for (let i = 0; i < POD_CAPACITY; i++) {
      await signUp(deps, podRoundId, `player-${i}`, guildId)
    }

    const stuck = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(stuck.status).toBe('THRESHOLD_REACHED')
    expect(stuck.ptpPodShareId).toBeNull()
    expect(stuck.thresholdReachedAt).not.toBeNull()

    const retryResults = await retryFailedFires(deps)
    const thisRetry = retryResults.find((r) => r.podRoundId === podRoundId)
    expect(thisRetry?.outcome).toBe('succeeded')
    expect(attempts).toBe(2)

    const recovered = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(recovered.status).toBe('POD_CREATED')
    expect(recovered.ptpPodShareId).toBe('share-1')
  })

  it('gives up after the retry window elapses, notifies once, and leaves the round cancellable rather than auto-cancelling it', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const createPod = stub(async (): Promise<never> => {
      throw new Error('PTP is down')
    })
    const deps: PodServiceDeps = {
      prisma,
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: NO_LOGGER,
    }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })
    for (let i = 0; i < POD_CAPACITY; i++) {
      await signUp(deps, podRoundId, `player-${i}`, guildId)
    }

    // Simulate 31 minutes having elapsed since the claim — RETRY_WINDOW_MS
    // is 30 minutes and isn't exported, so this backdates the same column
    // fireRound itself stamped rather than re-deriving that constant here.
    await prisma.podRound.update({
      where: { id: podRoundId },
      data: { thresholdReachedAt: new Date(Date.now() - 31 * 60 * 1000) },
    })

    // One call already happened during the original fireRound attempt
    // (triggered by the signup loop above, before the window was
    // artificially backdated) — that's the failure this test is retrying.
    expect(createPod.calls).toHaveLength(1)

    const firstSweep = await retryFailedFires(deps)
    const gaveUp = firstSweep.find((r) => r.podRoundId === podRoundId)
    expect(gaveUp?.outcome).toBe('gave-up')
    // Past the window — retryFailedFires must not attempt PTP again.
    expect(createPod.calls).toHaveLength(1)

    const stillStuck = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(stillStuck.status).toBe('THRESHOLD_REACHED')
    expect(stillStuck.fireFailureNotified).toBe(true)

    // A later sweep tick must not re-notify for the same round.
    const secondSweep = await retryFailedFires(deps)
    expect(secondSweep.find((r) => r.podRoundId === podRoundId)).toBeUndefined()

    // Deliberately not auto-cancelled — the organizer can still manually
    // cancel (or, if PTP recovers and someone manually intervenes, the
    // round is still in a state cancelActiveRound recognizes).
    const cancelResult = await cancelActiveRound(deps, organizerDiscordId)
    expect(cancelResult?.podRoundId).toBe(podRoundId)
    const cancelled = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(cancelled.status).toBe('CANCELLED')
  })

  it('concludePod rejects a second attempt to conclude the same round', async () => {
    const { organizerDiscordId, guildId } = await seedOrganizerAndGuild()
    const deps: PodServiceDeps = { prisma, ptp: succeedingPtp(), tokenEncryptionKey: TOKEN_KEY, logger: NO_LOGGER }

    const { podRoundId } = await startPod(deps, {
      organizerDiscordId,
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: [guildId],
    })
    for (let i = 0; i < POD_CAPACITY; i++) {
      await signUp(deps, podRoundId, `player-${i}`, guildId)
    }

    const first = await concludePod(deps, { podRoundId, requestedBy: organizerDiscordId })
    expect(first.ok).toBe(true)

    const second = await concludePod(deps, { podRoundId, requestedBy: organizerDiscordId })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.message).toMatch(/already been concluded/i)
  })
})
