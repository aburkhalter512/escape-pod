import { describe, expect, it } from 'vitest'
import { createExecutionContext, createScheduledController, env, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import type { EscapePodDurableObject, Env } from './durableObject.js'
import { POD_SWEEP_CRON, TOKEN_REFRESH_CRON } from './durableObject.js'
import { POD_CAPACITY } from './podConfig.js'
import { encryptToken } from './crypto/tokenCrypto.js'
import worker from './worker.js'

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

// Real Cron Trigger firing, dispatched the same way Cloudflare invokes
// scheduled() for real — createScheduledController + the actual default-
// exported worker module (not a hand-called function), same "import
// module from main gives the same instance SELF uses" pattern
// Cloudflare's own docs describe. Proves worker.ts's scheduled() handler
// reaches the singleton DO via a real RPC call (stub.runScheduledJob) and
// that job actually runs against real DO storage, not just that the
// function is wired up syntactically.

function getGlobalStub() {
  const id = env.ESCAPE_POD_DO.idFromName('global')
  return env.ESCAPE_POD_DO.get(id)
}

async function fireScheduled(cron: string): Promise<void> {
  const ctx = createExecutionContext()
  await worker.scheduled(createScheduledController({ cron }), env, ctx)
  // scheduled() dispatches via ctx.waitUntil(...) — the handler itself
  // returns before the real job finishes, same reasoning as honoApp.ts's
  // deferred interaction responses (see podConcurrency.workers.test.ts's
  // top comment), except here Cloudflare's own ExecutionContext API gives
  // a real, deterministic way to wait for it, so no polling is needed.
  await waitOnExecutionContext(ctx)
}

describe('worker.scheduled', () => {
  it('expires an overdue round with no signups on the pod-sweep cron', async () => {
    const stub = getGlobalStub()
    const podRoundId = await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      await instance.appStorage.organizer.upsert({
        where: { discordId: 'organizer-1' },
        create: {
          discordId: 'organizer-1',
          username: 'OrganizerOne',
          encryptedToken: encryptToken('fake-ptp-token', env.TOKEN_ENCRYPTION_KEY),
          expiresAt: new Date('2030-01-01'),
        },
        update: {
          username: 'OrganizerOne',
          encryptedToken: encryptToken('fake-ptp-token', env.TOKEN_ENCRYPTION_KEY),
          expiresAt: new Date('2030-01-01'),
        },
      })
      const round = await instance.appStorage.podRound.create({
        data: {
          organizerDiscordId: 'organizer-1',
          organizerRoundNumber: 1,
          setCode: 'JTL',
          threshold: POD_CAPACITY,
          scheduledFor: new Date(Date.now() - 60_000), // 1 minute in the past
          targets: { create: [] },
        },
      })
      return round.id
    })

    await fireScheduled(POD_SWEEP_CRON)

    await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
      const round = await instance.appStorage.podRound.findUnique({ where: { id: podRoundId } })
      expect(round?.status).toBe('EXPIRED')
    })
  })

  it("refreshes an organizer's token within the refresh window on the daily cron", async () => {
    const stub = getGlobalStub()
    const originalFetch = globalThis.fetch
    // ptp.refreshToken (jobs/refreshTokens.ts) reads the fresh JWT off a
    // Set-Cookie response header — see ptp/client.ts's refreshToken.
    const freshExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const freshToken = [
      Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ id: 'ptp-1', username: 'OrganizerOne', exp: freshExp })).toString('base64url'),
      'sig',
    ].join('.')
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/auth/refresh')) {
        return new Response(null, { status: 200, headers: { 'set-cookie': `swupod_session=${freshToken}; Path=/` } })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
        await instance.appStorage.organizer.upsert({
          where: { discordId: 'organizer-refresh' },
          create: {
            discordId: 'organizer-refresh',
            username: 'RefreshMe',
            encryptedToken: encryptToken('stale-token', env.TOKEN_ENCRYPTION_KEY),
            // Inside the 5-day refresh window (REFRESH_WINDOW_DAYS in
            // jobs/refreshTokens.ts) so this organizer is actually picked
            // up by the sweep.
            expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          },
          update: {
            username: 'RefreshMe',
            encryptedToken: encryptToken('stale-token', env.TOKEN_ENCRYPTION_KEY),
            expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          },
        })
      })

      await fireScheduled(TOKEN_REFRESH_CRON)

      // AppStorage.organizer has no by-discordId lookup (only findMany
      // filtered by expiresAt, and upsert/update — see storage/
      // appStorage.ts) — so this checks a cutoff strictly between the
      // seeded near-term expiry (2 days out) and the refreshed one (30
      // days out): present in this filtered set only if refresh did NOT
      // happen, since the seeded 2-day expiry is well inside the 5-day
      // refresh window this job actually consults.
      const midpointCutoff = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
      await runInDurableObject(stub, async (instance: EscapePodDurableObject) => {
        const stillNearTerm = await instance.appStorage.organizer.findMany({
          where: { expiresAt: { lt: midpointCutoff } },
        })
        expect(stillNearTerm.find((o) => o.discordId === 'organizer-refresh')).toBeUndefined()
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does nothing and logs rather than throwing for an unrecognized cron expression', async () => {
    await expect(fireScheduled('unrecognized-cron')).resolves.toBeUndefined()
  })
})
