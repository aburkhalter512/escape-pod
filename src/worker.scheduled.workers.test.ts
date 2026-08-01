import { describe, expect, it } from 'vitest'
import { createExecutionContext, createScheduledController, env, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import type { EscapePodDurableObject, Env } from './durableObject.js'
import { POD_SWEEP_CRON } from './durableObject.js'
import { POD_CAPACITY } from './podConfig.js'
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
      // Creates the organizer row as a side effect (no separate linking
      // step exists anymore — see organizer.incrementNextRoundNumber's
      // upsert) so pod_rounds' FK to organizers(discord_id) is
      // satisfiable; increment: 0 is a test-only seeding trick.
      await instance.appStorage.organizer.incrementNextRoundNumber({
        where: { discordId: 'organizer-1' },
        data: { increment: 0 },
      })
      const round = await instance.appStorage.podRound.createRoundWithTargets({
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
      const round = await instance.appStorage.podRound.findRoundById(podRoundId)
      expect(round?.status).toBe('EXPIRED')
    })
  })

  // No token-refresh cron test anymore — Niamos tokens never expire, so
  // jobs/refreshTokens.ts and its daily cron were deleted entirely
  // rather than adapted (see the migration plan). POD_SWEEP_CRON above
  // is the only cron this Worker declares now.

  it('does nothing and logs rather than throwing for an unrecognized cron expression', async () => {
    await expect(fireScheduled('unrecognized-cron')).resolves.toBeUndefined()
  })
})
