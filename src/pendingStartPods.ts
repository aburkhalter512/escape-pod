// Holds a /start-pod guild selection between the "select servers" step and
// the "Send" confirmation click (see interactions/components.ts) — a
// review step the selection itself can't carry in its own custom_id,
// since up to 25 Discord snowflakes blow past the 100-character custom_id
// limit by a wide margin. In-process only, same "no new infra for
// something with low consequences if lost" philosophy as
// jobs/expirePodRounds.ts's periodic sweep: if this is lost across a
// deploy, the organizer just re-runs /start-pod — nothing was ever
// created or posted, so there's nothing to reconcile.
export interface PendingStartPod {
  organizerDiscordId: string
  setCode: string
  threshold: number
  scheduledFor?: Date
  originGuildName?: string
  originGuildId?: string
  guildIds: string[]
}

export interface PendingStartPodStore {
  // Returns a token short enough to embed in a button's custom_id.
  create(pending: PendingStartPod): string
  get(token: string): PendingStartPod | undefined
  delete(token: string): void
}

// Deliberately generous, and deliberately not matched to Discord's own
// 15-minute interaction-token window: that window governs how long
// Discord will accept a *response* to a specific interaction, not how
// long this selection should be kept — a very late Send click still
// arrives as its own fresh interaction with its own budget, so this TTL
// only needs to outlive realistic "I got distracted" gaps, not race
// Discord's window.
const TTL_MS = 60 * 60_000

export function createInMemoryPendingStartPodStore(): PendingStartPodStore {
  const store = new Map<string, { pending: PendingStartPod; createdAt: number }>()

  function evictExpired(): void {
    const cutoff = Date.now() - TTL_MS
    for (const [token, entry] of store) {
      if (entry.createdAt < cutoff) store.delete(token)
    }
  }

  return {
    create(pending) {
      evictExpired()
      const token = crypto.randomUUID()
      store.set(token, { pending, createdAt: Date.now() })
      return token
    },
    get(token) {
      return store.get(token)?.pending
    },
    delete(token) {
      store.delete(token)
    },
  }
}
