import type { PendingStartPod, PendingStartPodStore } from '../pendingStartPods.js'
import { maybeOne, toIso, fromIsoNullable } from './rowMappers.js'

// The Worker/DO-side counterpart to pendingStartPods.ts's
// createInMemoryPendingStartPodStore — same PendingStartPodStore
// interface (synchronous create/get/delete; DO SQLite's SqlStorage.exec
// is itself synchronous, unlike every other AppStorage method in this
// codebase, so this can satisfy that exact interface with zero changes
// needed at any call site in interactions/components.ts), backed by real
// DO storage instead of an in-memory Map.
//
// Why this exists at all (see storage/schema.ts's migration 2 comment
// for the fuller story): a Durable Object's in-memory JS state — unlike
// its persistent storage — gets evicted by Cloudflare on routine idle
// timeout, not just on a deploy/crash the way an AWS process restarts.
// The /start-pod flow has a real human pause between the "select
// servers" step (which creates a pending selection) and the "Send"
// confirmation click (which reads it back) — an in-memory-only store
// would silently lose that selection across an eviction in between,
// more plausibly than the AWS original's "lost on rare process restart"
// tradeoff. Storing it in the DO's own SQLite table instead means it
// survives eviction/rehydration exactly like every other piece of this
// app's state does.
//
// One accepted tradeoff this introduces vs. the in-memory version: an
// abandoned selection (organizer never clicks confirm/cancel) used to be
// wiped for free whenever the DO's in-memory state was evicted; here it
// persists in SQLite until some *future* create() sweeps it. evictExpired
// also runs from get() (below), not just create(), to keep that gap
// small in practice — every confirm/cancel click sweeps too, not just
// new /start-pod invocations.
const TTL_MS = 60 * 60_000

export function createSqlPendingStartPodStore(sql: SqlStorage): PendingStartPodStore {
  function evictExpired(): void {
    const cutoff = toIso(new Date(Date.now() - TTL_MS))
    sql.exec('DELETE FROM pending_start_pods WHERE created_at < ?', cutoff)
  }

  return {
    create(pending) {
      evictExpired()
      const token = crypto.randomUUID()
      sql.exec(
        `INSERT INTO pending_start_pods (
           token, organizer_discord_id, set_code, threshold, scheduled_for,
           origin_guild_name, origin_guild_id, guild_ids, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        token,
        pending.organizerDiscordId,
        pending.setCode,
        pending.threshold,
        pending.scheduledFor ? toIso(pending.scheduledFor) : null,
        pending.originGuildName ?? null,
        pending.originGuildId ?? null,
        JSON.stringify(pending.guildIds),
        toIso(new Date())
      )
      return token
    },
    get(token) {
      evictExpired()
      const row = maybeOne(sql, 'SELECT * FROM pending_start_pods WHERE token = ?', token)
      if (!row) return undefined
      const pending: PendingStartPod = {
        organizerDiscordId: row.organizer_discord_id as string,
        setCode: row.set_code as string,
        threshold: row.threshold as number,
        guildIds: JSON.parse(row.guild_ids as string) as string[],
      }
      const scheduledFor = fromIsoNullable(row.scheduled_for)
      if (scheduledFor) pending.scheduledFor = scheduledFor
      if (row.origin_guild_name) pending.originGuildName = row.origin_guild_name as string
      if (row.origin_guild_id) pending.originGuildId = row.origin_guild_id as string
      return pending
    },
    delete(token) {
      sql.exec('DELETE FROM pending_start_pods WHERE token = ?', token)
    },
  }
}
