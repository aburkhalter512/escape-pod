import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POD_CAPACITY } from './podConfig.js'
import { createFakePtpClient } from './testUtils/fakePtpClient.js'
import { stub } from './testUtils/stub.js'
import { createIntegrationPrisma, resetDb } from './testUtils/integrationDb.js'
import { createIntegrationBackend, linkFakeOrganizer } from './testUtils/integrationBackend.js'

// The one guarantee no fake Prisma client can prove (see tasks/001):
// fireRound's claim is a WHERE-guarded updateMany, relied on to behave as
// an atomic compare-and-swap under real concurrent writers. A fake
// in-memory Prisma client just runs each call's JS synchronously up to its
// next `await`, so two "concurrent" calls in a unit test never actually
// interleave at the SQL level the way two real connections racing the
// same UPDATE do. This test exercises the real thing: several real,
// concurrently-issued Postgres connections all racing to be the signup
// that pushes the round to POD_CAPACITY — driven entirely through
// BackendClient, the same interface commands/* and interactions/* call in
// production (see testUtils/integrationBackend.ts), never through
// services/pods.ts or prisma directly.
const prisma = createIntegrationPrisma()

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb(prisma)
})

describe('signing up under real concurrent writers', () => {
  it('fires the round exactly once even when many signups race past POD_CAPACITY simultaneously', async () => {
    // Deliberately delayed — widens the race window so concurrent callers
    // are still mid-flight through fireRound's claim at the same moment,
    // rather than accidentally serializing behind Node's own scheduling.
    const createPod = stub(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { id: 'pod-1', shareId: 'share-1', shareUrl: 'https://example.com/pod-1', createdAt: new Date().toISOString() }
    })
    const backend = createIntegrationBackend(prisma, createFakePtpClient({ validateToken: async () => true, createPod }))

    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    const subscribed = await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })
    expect(subscribed.ok).toBe(true)

    const { podRoundId } = await backend.startPod({
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      guildIds: ['guild-1'],
    })

    // More concurrent signups than POD_CAPACITY — every one of them will
    // observe a count >= POD_CAPACITY and attempt to fire the round; only
    // the real DB-level compare-and-swap decides which single call
    // actually wins.
    const signupCount = POD_CAPACITY + 4
    const results = await Promise.all(
      Array.from({ length: signupCount }, (_, i) =>
        backend.recordSignup(podRoundId, `player-${i}`, `Player${i}`, 'guild-1', 'in')
      )
    )

    // Every concurrent signup is still individually accepted — the
    // atomic claim only decides who gets to attempt PTP pod creation, it
    // never rejects a signup itself (the round is still 'COLLECTING' from
    // each caller's own initial read, since the claim only happens deep
    // inside whichever call actually observes a full table).
    expect(results.every((r) => r.ok)).toBe(true)

    expect(createPod.calls).toHaveLength(1)

    const podCreatedResults = results.filter((r) => r.ok && r.value.podCreated)
    expect(podCreatedResults).toHaveLength(1)
    if (podCreatedResults[0].ok) {
      expect(podCreatedResults[0].value.shareUrl).toBe('https://example.com/pod-1')
    }

    // Further proof the round really did transition and stay fired
    // (rather than, say, silently reverting) — a signup attempted after
    // every concurrent call has settled is still rejected as "already
    // started," which is only true once the round is no longer COLLECTING.
    const lateSignup = await backend.recordSignup(podRoundId, 'late-player', 'LatePlayer', 'guild-1', 'in')
    expect(lateSignup.ok).toBe(false)
    if (!lateSignup.ok) expect(lateSignup.error.message).toMatch(/already started/i)
  })
})

describe('per-organizer round numbering under real concurrent writers', () => {
  // The other guarantee only real Postgres can prove (see startPod's own
  // doc comment in services/pods.ts): Organizer.nextRoundNumber is
  // incremented via a plain UPDATE, not a WHERE-guarded compare-and-swap
  // like fireRound's claim — its safety instead relies entirely on
  // Postgres serializing concurrent UPDATEs to the same row. A fake
  // Prisma client can't exercise that at all (see this file's own
  // top-of-file comment), so this is the one place that actually proves
  // no two concurrent /start-pod calls from the same organizer ever
  // receive the same round number, or leave a gap.
  it('assigns distinct, gap-free sequential numbers even when many /start-pod calls race for the same organizer', async () => {
    const backend = createIntegrationBackend(prisma)
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const startCount = 20
    const results = await Promise.all(
      Array.from({ length: startCount }, () =>
        backend.startPod({ organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['guild-1'] })
      )
    )

    const numbers = results.map((r) => r.organizerRoundNumber).sort((a, b) => a - b)
    expect(new Set(numbers).size).toBe(startCount) // no duplicates
    expect(numbers).toEqual(Array.from({ length: startCount }, (_, i) => i + 1)) // exactly 1..N, no gaps
  })

  it('scopes numbering per organizer — two organizers racing simultaneously never see each other\'s numbers', async () => {
    const backend = createIntegrationBackend(prisma)
    await linkFakeOrganizer(backend, 'organizer-1', 'OrganizerOne')
    await linkFakeOrganizer(backend, 'organizer-2', 'OrganizerTwo')
    await backend.subscribeGuild('guild-1', 'organizer-1', { channelId: 'channel-1' })

    const startCount = 10
    const [resultsOne, resultsTwo] = await Promise.all([
      Promise.all(
        Array.from({ length: startCount }, () =>
          backend.startPod({ organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['guild-1'] })
        )
      ),
      Promise.all(
        Array.from({ length: startCount }, () =>
          backend.startPod({ organizerDiscordId: 'organizer-2', setCode: 'SOR', threshold: 8, guildIds: ['guild-1'] })
        )
      ),
    ])

    const expected = Array.from({ length: startCount }, (_, i) => i + 1)
    expect(resultsOne.map((r) => r.organizerRoundNumber).sort((a, b) => a - b)).toEqual(expected)
    expect(resultsTwo.map((r) => r.organizerRoundNumber).sort((a, b) => a - b)).toEqual(expected)
  })
})
