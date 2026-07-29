import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EscapePodDurableObject, Env } from '../durableObject.js'
import { createSqlPendingStartPodStore } from './pendingStartPodsSql.js'

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

// Real DO SQLite storage, not a mock — this is the fix for a real bug a
// PR reviewer caught: an in-memory Map (like pendingStartPods.ts's
// createInMemoryPendingStartPodStore) doesn't survive a DO's routine
// idle-eviction/rehydration cycle, unlike its persistent storage.
// podConcurrency.workers.test.ts's /start-pod select-guilds/confirm flow
// already exercises this indirectly through real HTTP requests; this
// file is the store's own direct, focused coverage. runInDurableObject's
// second callback argument (the raw DurableObjectState) is what gives
// access to ctx.storage.sql directly, independent of
// EscapePodDurableObject's own appStorage field (which wraps a different
// AppStorage-shaped contract, not the raw SqlStorage this store needs).
function getStub(name: string) {
  const id = env.ESCAPE_POD_DO.idFromName(name)
  return env.ESCAPE_POD_DO.get(id)
}

describe('createSqlPendingStartPodStore', () => {
  it('create then get round-trips every field, including optional ones', async () => {
    const stub = getStub('pending-round-trip')
    await runInDurableObject(stub, async (_instance: EscapePodDurableObject, state) => {
      const store = createSqlPendingStartPodStore(state.storage.sql)

      const token = store.create({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        scheduledFor: new Date('2030-01-01T00:00:00.000Z'),
        originGuildName: 'Test Guild',
        originGuildId: 'guild-1',
        guildIds: ['guild-1', 'guild-2'],
      })

      expect(typeof token).toBe('string')
      expect(store.get(token)).toEqual({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        scheduledFor: new Date('2030-01-01T00:00:00.000Z'),
        originGuildName: 'Test Guild',
        originGuildId: 'guild-1',
        guildIds: ['guild-1', 'guild-2'],
      })
    })
  })

  it('omits optional fields entirely (not null) when they were never set', async () => {
    const stub = getStub('pending-optional-fields')
    await runInDurableObject(stub, async (_instance: EscapePodDurableObject, state) => {
      const store = createSqlPendingStartPodStore(state.storage.sql)

      const token = store.create({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        guildIds: ['guild-1'],
      })

      const pending = store.get(token)
      expect(pending).toEqual({
        organizerDiscordId: 'organizer-1',
        setCode: 'JTL',
        threshold: 8,
        guildIds: ['guild-1'],
      })
      expect(pending).not.toHaveProperty('scheduledFor')
      expect(pending).not.toHaveProperty('originGuildName')
      expect(pending).not.toHaveProperty('originGuildId')
    })
  })

  it('get returns undefined for an unknown token', async () => {
    const stub = getStub('pending-unknown-token')
    await runInDurableObject(stub, async (_instance: EscapePodDurableObject, state) => {
      const store = createSqlPendingStartPodStore(state.storage.sql)
      expect(store.get('no-such-token')).toBeUndefined()
    })
  })

  it('delete removes a pending selection, get returns undefined after', async () => {
    const stub = getStub('pending-delete')
    await runInDurableObject(stub, async (_instance: EscapePodDurableObject, state) => {
      const store = createSqlPendingStartPodStore(state.storage.sql)
      const token = store.create({ organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: [] })

      store.delete(token)

      expect(store.get(token)).toBeUndefined()
    })
  })

  it('survives being re-created against the same underlying storage (simulates DO rehydration)', async () => {
    const stub = getStub('pending-rehydration')
    const token = await runInDurableObject(stub, async (_instance: EscapePodDurableObject, state) => {
      const firstStoreInstance = createSqlPendingStartPodStore(state.storage.sql)
      return firstStoreInstance.create({ organizerDiscordId: 'organizer-1', setCode: 'JTL', threshold: 8, guildIds: ['guild-1'] })
    })

    // A brand new createSqlPendingStartPodStore call, backed by the same
    // real storage — exactly what happens after a DO eviction and
    // rehydration: durableObject.ts's constructor runs again, calling
    // createSqlPendingStartPodStore fresh, but the underlying SQLite
    // table (unlike an in-memory Map) is untouched.
    await runInDurableObject(stub, async (_instance: EscapePodDurableObject, state) => {
      const secondStoreInstance = createSqlPendingStartPodStore(state.storage.sql)
      expect(secondStoreInstance.get(token)).toMatchObject({ organizerDiscordId: 'organizer-1' })
    })
  })
})
