import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryPendingStartPodStore, type PendingStartPod } from './pendingStartPods.js'

function fakePending(overrides: Partial<PendingStartPod> = {}): PendingStartPod {
  return {
    organizerDiscordId: 'organizer-1',
    setCode: 'JTL',
    threshold: 8,
    guildIds: ['g1', 'g2'],
    ...overrides,
  }
}

describe('createInMemoryPendingStartPodStore', () => {
  it('returns the same pending value for the token create() returned', () => {
    const store = createInMemoryPendingStartPodStore()
    const pending = fakePending()

    const token = store.create(pending)

    expect(store.get(token)).toEqual(pending)
  })

  it('returns undefined for an unknown token', () => {
    const store = createInMemoryPendingStartPodStore()

    expect(store.get('never-created')).toBeUndefined()
  })

  it('returns undefined after delete()', () => {
    const store = createInMemoryPendingStartPodStore()
    const token = store.create(fakePending())

    store.delete(token)

    expect(store.get(token)).toBeUndefined()
  })

  it('delete() on an unknown token is a no-op, not an error', () => {
    const store = createInMemoryPendingStartPodStore()

    expect(() => store.delete('never-created')).not.toThrow()
  })

  it('gives each create() call a distinct token, even for identical pending data', () => {
    const store = createInMemoryPendingStartPodStore()
    const pending = fakePending()

    const tokenA = store.create(pending)
    const tokenB = store.create(pending)

    expect(tokenA).not.toBe(tokenB)
    expect(store.get(tokenA)).toEqual(pending)
    expect(store.get(tokenB)).toEqual(pending)
  })

  it('keeps entries independent — deleting one does not affect another', () => {
    const store = createInMemoryPendingStartPodStore()
    const tokenA = store.create(fakePending({ setCode: 'JTL' }))
    const tokenB = store.create(fakePending({ setCode: 'LOF' }))

    store.delete(tokenA)

    expect(store.get(tokenA)).toBeUndefined()
    expect(store.get(tokenB)).toEqual(fakePending({ setCode: 'LOF' }))
  })

  describe('TTL eviction', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('still returns an entry well within the TTL', () => {
      const store = createInMemoryPendingStartPodStore()
      const token = store.create(fakePending())

      vi.advanceTimersByTime(30 * 60_000) // 30 minutes — under the 1-hour TTL

      expect(store.get(token)).toEqual(fakePending())
    })

    it('evicts an entry older than the TTL the next time create() runs', () => {
      const store = createInMemoryPendingStartPodStore()
      const staleToken = store.create(fakePending({ setCode: 'JTL' }))

      vi.advanceTimersByTime(61 * 60_000) // past the 1-hour TTL
      store.create(fakePending({ setCode: 'LOF' })) // eviction is lazy, on create()

      expect(store.get(staleToken)).toBeUndefined()
    })
  })
})
