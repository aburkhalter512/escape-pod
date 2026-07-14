import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { recordSignup, type PodServiceDeps } from './pods.js'
import { POD_CAPACITY } from '../podConfig.js'
import { encryptToken } from '../crypto/tokenCrypto.js'
import { createFakePtpClient } from '../testUtils/fakePtpClient.js'
import { stub } from '../testUtils/stub.js'
import { createIntegrationPrisma, resetDb } from '../testUtils/integrationDb.js'

// The one guarantee no fake Prisma client can prove (see tasks/001):
// fireRound's claim is a WHERE-guarded updateMany, relied on to behave
// as an atomic compare-and-swap under real concurrent writers. A fake
// in-memory Prisma client just runs each call's JS synchronously up to
// its next `await`, so two "concurrent" calls in a unit test never
// actually interleave at the SQL level the way two real connections
// racing the same UPDATE do. This test exercises the real thing:
// several real, concurrently-issued Postgres connections all racing to
// be the signup that pushes the round to POD_CAPACITY.
const TOKEN_KEY = '00'.repeat(32)

const prisma = createIntegrationPrisma()

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDb(prisma)
})

async function seedCollectingRound(): Promise<string> {
  await prisma.organizer.create({
    data: {
      discordId: 'organizer-1',
      username: 'OrganizerOne',
      encryptedToken: encryptToken('a-real-token', TOKEN_KEY),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
  const round = await prisma.podRound.create({
    data: {
      organizerDiscordId: 'organizer-1',
      setCode: 'JTL',
      threshold: POD_CAPACITY,
      status: 'COLLECTING',
    },
  })
  return round.id
}

describe('recordSignup under real concurrent writers', () => {
  it('fires the round exactly once even when many signups race past POD_CAPACITY simultaneously', async () => {
    const podRoundId = await seedCollectingRound()

    // Deliberately delayed — widens the race window so concurrent callers
    // are still mid-flight through fireRound's claim at the same moment,
    // rather than accidentally serializing behind Node's own scheduling.
    const createPod = stub(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { id: 'pod-1', shareId: 'share-1', shareUrl: 'https://example.com/pod-1', createdAt: new Date().toISOString() }
    })
    const deps: PodServiceDeps = {
      prisma,
      ptp: createFakePtpClient({ createPod }),
      tokenEncryptionKey: TOKEN_KEY,
      logger: { error: () => undefined },
    }

    // More concurrent signups than POD_CAPACITY — every one of them will
    // observe (via its own findMany) a count >= POD_CAPACITY and attempt
    // to fire the round; only the real DB-level compare-and-swap decides
    // which single call actually wins.
    const signupCount = POD_CAPACITY + 4
    const results = await Promise.all(
      Array.from({ length: signupCount }, (_, i) =>
        recordSignup(deps, {
          podRoundId,
          discordId: `player-${i}`,
          username: `Player${i}`,
          sourceGuildId: 'guild-1',
          action: 'in',
        })
      )
    )

    expect(createPod.calls).toHaveLength(1)

    const podCreatedResults = results.filter((r) => r.ok && r.value.podCreated)
    expect(podCreatedResults).toHaveLength(1)

    const finalRound = await prisma.podRound.findUniqueOrThrow({ where: { id: podRoundId } })
    expect(finalRound.status).toBe('POD_CREATED')
    expect(finalRound.ptpPodShareId).toBe('share-1')

    const signups = await prisma.podRoundSignup.findMany({ where: { podRoundId, status: 'IN' } })
    expect(signups).toHaveLength(signupCount)
  })
})
