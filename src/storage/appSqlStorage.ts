import type { Prisma, Organizer, PodRound, PodRoundStatus } from '@prisma/client'
import type { AppStorage } from './appStorage.js'
import {
  one,
  maybeOne,
  all,
  toIso,
  mapOrganizerRow,
  mapGuildSubscriptionRow,
  mapGuildOrganizerAllowlistRow,
  mapGuildOriginAllowlistRow,
  mapPodRoundRow,
  mapPodRoundTargetRow,
  mapPodRoundSignupRow,
} from './rowMappers.js'

// The Durable Object SQLite implementation of appStorage.ts's AppStorage
// contract — hand-written parameterized SQL instead of a generated
// client or query-builder dialect (no Prisma driver adapter exists for
// DO's synchronous, non-network SqlStorage object, and a 7-table schema
// with this bounded a query surface doesn't need one).
export type { AppStorage }

// Shared by podRoundFindUnique/podRoundFindMany's include-organizer
// branches below — was inlined identically in both places before.
function findOrganizer(sql: SqlStorage, discordId: string): Organizer {
  return mapOrganizerRow(one(sql, 'SELECT * FROM organizers WHERE discord_id = ?', discordId))
}

// The three concrete queries AppStorage's podRound.findMany overloads
// collapse into one generic-where-shape signature — split into their
// own named functions (one per real caller) instead of one function
// branching on which fields happen to be present in args.where, per
// PR review.

// services/organizers.ts's listActiveRoundsForOrganizer — never includes
// the organizer (the caller already knows who it is).
function findActiveRoundsForOrganizer(sql: SqlStorage, organizerDiscordId: string, statuses: PodRoundStatus[]): PodRound[] {
  const placeholders = statuses.map(() => '?').join(', ')
  const rows = all(
    sql,
    `SELECT * FROM pod_rounds WHERE organizer_discord_id = ? AND status IN (${placeholders}) ORDER BY organizer_round_number ASC`,
    organizerDiscordId,
    ...statuses
  )
  return rows.map(mapPodRoundRow)
}

// services/pods.ts's expireOverdueRounds — always includes the
// organizer (fireRound needs their encrypted PTP token to fire).
function findOverduePodRounds(sql: SqlStorage, status: PodRoundStatus, scheduledBefore: Date) {
  const rows = all(
    sql,
    'SELECT * FROM pod_rounds WHERE status = ? AND scheduled_for IS NOT NULL AND scheduled_for <= ?',
    status,
    toIso(scheduledBefore)
  )
  return rows.map(mapPodRoundRow).map((round) => ({ ...round, organizer: findOrganizer(sql, round.organizerDiscordId) }))
}

// services/pods.ts's retryFailedFires — always includes the organizer,
// same reasoning as findOverduePodRounds above.
function findStuckThresholdReachedRounds(sql: SqlStorage, status: PodRoundStatus) {
  const rows = all(sql, 'SELECT * FROM pod_rounds WHERE status = ? AND fire_failure_notified = 0', status)
  return rows.map(mapPodRoundRow).map((round) => ({ ...round, organizer: findOrganizer(sql, round.organizerDiscordId) }))
}

export function createAppSqlStorage(sql: SqlStorage): AppStorage {
  // Object-literal methods can't declare TS overload signatures directly
  // (only one call signature per key) — findUnique/findMany's two
  // distinct include-vs-not return shapes need real function-declaration
  // overloads, so they're pulled out here and referenced by name in the
  // returned object below, instead of being written inline.
  function podRoundFindUnique(args: { where: { id: string } }): Promise<PodRound | null>
  function podRoundFindUnique(
    args: { where: { id: string }; include: { organizer: true } }
  ): Promise<Prisma.PodRoundGetPayload<{ include: { organizer: true } }> | null>
  async function podRoundFindUnique(args: { where: { id: string }; include?: { organizer: true } }) {
    const row = maybeOne(sql, 'SELECT * FROM pod_rounds WHERE id = ?', args.where.id)
    if (!row) return null
    const round = mapPodRoundRow(row)
    if (!args.include) return round
    return { ...round, organizer: findOrganizer(sql, round.organizerDiscordId) }
  }

  // The dispatcher itself stays generic (it has to, to satisfy one
  // overloaded AppStorage method) — but its body is now just "which
  // dedicated query does this shape mean," not the query logic itself.
  function podRoundFindMany(args: {
    where: { organizerDiscordId: string; status: { in: PodRoundStatus[] } }
    orderBy: { organizerRoundNumber: 'asc' }
  }): Promise<PodRound[]>
  function podRoundFindMany(
    args: { where: Record<string, unknown>; include: { organizer: true } }
  ): Promise<Array<Prisma.PodRoundGetPayload<{ include: { organizer: true } }>>>
  async function podRoundFindMany(args: {
    where: Record<string, unknown>
    include?: { organizer: true }
    orderBy?: { organizerRoundNumber: 'asc' }
  }) {
    if ('organizerDiscordId' in args.where && 'status' in args.where) {
      const statusFilter = args.where.status as { in: PodRoundStatus[] }
      return findActiveRoundsForOrganizer(sql, args.where.organizerDiscordId as string, statusFilter.in)
    }
    if ('status' in args.where && 'scheduledFor' in args.where) {
      const scheduledFilter = args.where.scheduledFor as { lte: Date }
      return findOverduePodRounds(sql, args.where.status as PodRoundStatus, scheduledFilter.lte)
    }
    // retryFailedFires: { status: 'THRESHOLD_REACHED', fireFailureNotified: false }
    return findStuckThresholdReachedRounds(sql, args.where.status as PodRoundStatus)
  }

  return {
    organizer: {
      async findMany(args) {
        const rows = all(sql, 'SELECT * FROM organizers WHERE expires_at < ?', toIso(args.where.expiresAt.lt))
        return rows.map(mapOrganizerRow)
      },
      async incrementNextRoundNumber(args) {
        const row = one(
          sql,
          'UPDATE organizers SET next_round_number = next_round_number + ? WHERE discord_id = ? RETURNING *',
          args.data.increment,
          args.where.discordId
        )
        return mapOrganizerRow(row)
      },
      async updateToken(args) {
        const row = one(
          sql,
          'UPDATE organizers SET encrypted_token = ?, expires_at = ? WHERE discord_id = ? RETURNING *',
          args.data.encryptedToken,
          toIso(args.data.expiresAt),
          args.where.discordId
        )
        return mapOrganizerRow(row)
      },
      async upsert(args) {
        // ON CONFLICT SET binds args.update.*'s own values explicitly
        // rather than referencing excluded.* (which would silently reuse
        // args.create.*'s values instead) — the two objects are allowed
        // to differ per the interface's own contract, even though every
        // real caller today happens to pass matching values for both.
        const row = one(
          sql,
          `INSERT INTO organizers (discord_id, username, encrypted_token, expires_at, linked_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (discord_id) DO UPDATE SET
             username = ?,
             encrypted_token = ?,
             expires_at = ?
           RETURNING *`,
          args.where.discordId,
          args.create.username,
          args.create.encryptedToken,
          toIso(args.create.expiresAt),
          toIso(new Date()),
          args.update.username,
          args.update.encryptedToken,
          toIso(args.update.expiresAt)
        )
        return mapOrganizerRow(row)
      },
    },

    guildSubscription: {
      async findMany(
        args:
          | { where: { guildId: { in: string[] }; unsubscribedAt: null } }
          | {
              where: {
                unsubscribedAt: null
                OR: [{ postingPolicy: 'OPEN' }, { originAllowlist: { some: { allowedOriginGuildId: string } } }]
              }
            }
      ) {
        // Only two shapes are ever called: listEligibleGuilds's OPEN/trust
        // OR-clause (no guildId filter), and startPod's guildId-in-list
        // filter (no OR clause) — handled as two branches rather than a
        // generic WHERE-clause builder, since that's the whole call
        // surface.
        if ('OR' in args.where) {
          const originGuildId = args.where.OR[1].originAllowlist.some.allowedOriginGuildId
          const rows = all(
            sql,
            `SELECT DISTINCT gs.* FROM guild_subscriptions gs
             LEFT JOIN guild_origin_allowlist goa ON goa.guild_id = gs.guild_id AND goa.allowed_origin_guild_id = ?
             WHERE gs.unsubscribed_at IS NULL AND (gs.posting_policy = 'OPEN' OR goa.guild_id IS NOT NULL)`,
            originGuildId
          )
          return rows.map(mapGuildSubscriptionRow)
        }
        const guildIds = args.where.guildId.in
        if (guildIds.length === 0) return []
        const placeholders = guildIds.map(() => '?').join(', ')
        const rows = all(
          sql,
          `SELECT * FROM guild_subscriptions WHERE unsubscribed_at IS NULL AND guild_id IN (${placeholders})`,
          ...guildIds
        )
        return rows.map(mapGuildSubscriptionRow)
      },
      async findUnique(args) {
        const row = maybeOne(sql, 'SELECT * FROM guild_subscriptions WHERE guild_id = ?', args.where.guildId)
        return row ? mapGuildSubscriptionRow(row) : null
      },
      async create(args) {
        const row = one(
          sql,
          `INSERT INTO guild_subscriptions (guild_id, installed_by_discord_id, broadcast_channel_id, posting_policy, installed_at)
           VALUES (?, ?, ?, ?, ?)
           RETURNING *`,
          args.data.guildId,
          args.data.installedByDiscordId,
          args.data.broadcastChannelId,
          args.data.postingPolicy ?? 'ALLOWLIST',
          toIso(new Date())
        )
        return mapGuildSubscriptionRow(row)
      },
      async update(args) {
        const sets: string[] = []
        const values: unknown[] = []
        if (args.data.broadcastChannelId !== undefined) {
          sets.push('broadcast_channel_id = ?')
          values.push(args.data.broadcastChannelId)
        }
        if (args.data.postingPolicy !== undefined) {
          sets.push('posting_policy = ?')
          values.push(args.data.postingPolicy)
        }
        if ('unsubscribedAt' in args.data) {
          sets.push('unsubscribed_at = ?')
          values.push(args.data.unsubscribedAt ? toIso(args.data.unsubscribedAt) : null)
        }
        values.push(args.where.guildId)
        const row = one(sql, `UPDATE guild_subscriptions SET ${sets.join(', ')} WHERE guild_id = ? RETURNING *`, ...values)
        return mapGuildSubscriptionRow(row)
      },
      async count(_args) {
        const row = one<{ n: number }>(sql, 'SELECT COUNT(*) as n FROM guild_subscriptions WHERE unsubscribed_at IS NULL')
        return row.n
      },
    },

    guildOrganizerAllowlist: {
      async upsert(args) {
        const row = one(
          sql,
          `INSERT INTO guild_organizer_allowlist (guild_id, organizer_discord_id, approved_by, approved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, organizer_discord_id) DO UPDATE SET approved_by = ?
           RETURNING *`,
          args.where.guildId_organizerDiscordId.guildId,
          args.where.guildId_organizerDiscordId.organizerDiscordId,
          args.create.approvedBy,
          toIso(new Date()),
          args.update.approvedBy
        )
        return mapGuildOrganizerAllowlistRow(row)
      },
    },

    guildOriginAllowlist: {
      async upsert(args) {
        const row = one(
          sql,
          `INSERT INTO guild_origin_allowlist (guild_id, allowed_origin_guild_id, approved_by, approved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, allowed_origin_guild_id) DO UPDATE SET approved_by = ?
           RETURNING *`,
          args.where.guildId_allowedOriginGuildId.guildId,
          args.where.guildId_allowedOriginGuildId.allowedOriginGuildId,
          args.create.approvedBy,
          toIso(new Date()),
          args.update.approvedBy
        )
        return mapGuildOriginAllowlistRow(row)
      },
    },

    podRound: {
      async create(args) {
        const id = crypto.randomUUID()
        const now = toIso(new Date())
        const row = one(
          sql,
          `INSERT INTO pod_rounds (
             id, organizer_discord_id, organizer_round_number, set_code, threshold,
             scheduled_for, origin_guild_name, origin_guild_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
          id,
          args.data.organizerDiscordId,
          args.data.organizerRoundNumber,
          args.data.setCode,
          args.data.threshold,
          args.data.scheduledFor ? toIso(args.data.scheduledFor) : null,
          args.data.originGuildName ?? null,
          args.data.originGuildId ?? null,
          now
        )
        for (const target of args.data.targets.create) {
          sql.exec(
            `INSERT INTO pod_round_targets (pod_round_id, guild_id, channel_id, posted_at) VALUES (?, ?, ?, ?)`,
            id,
            target.guildId,
            target.channelId,
            now
          )
        }
        return mapPodRoundRow(row)
      },
      findUnique: podRoundFindUnique,
      async findFirst(args) {
        if ('organizerRoundNumber' in args.where) {
          const row = maybeOne(
            sql,
            'SELECT * FROM pod_rounds WHERE organizer_discord_id = ? AND organizer_round_number = ?',
            args.where.organizerDiscordId,
            args.where.organizerRoundNumber
          )
          return row ? mapPodRoundRow(row) : null
        }
        const row = maybeOne(
          sql,
          'SELECT * FROM pod_rounds WHERE organizer_discord_id = ? ORDER BY created_at DESC LIMIT 1',
          args.where.organizerDiscordId
        )
        return row ? mapPodRoundRow(row) : null
      },
      findMany: podRoundFindMany,
      async update(args) {
        const sets: string[] = []
        const values: unknown[] = []
        if (args.data.status !== undefined) {
          sets.push('status = ?')
          values.push(args.data.status)
        }
        if (args.data.ptpPodShareId !== undefined) {
          sets.push('ptp_pod_share_id = ?')
          values.push(args.data.ptpPodShareId)
        }
        if (args.data.chatChannelId !== undefined) {
          sets.push('chat_channel_id = ?')
          values.push(args.data.chatChannelId)
        }
        if (args.data.fireFailureNotified !== undefined) {
          sets.push('fire_failure_notified = ?')
          values.push(args.data.fireFailureNotified ? 1 : 0)
        }
        values.push(args.where.id)
        const row = one(sql, `UPDATE pod_rounds SET ${sets.join(', ')} WHERE id = ? RETURNING *`, ...values)
        return mapPodRoundRow(row)
      },
      async updateMany(args) {
        const sets: string[] = []
        const values: unknown[] = []
        if (args.data.status !== undefined) {
          sets.push('status = ?')
          values.push(args.data.status)
        }
        if (args.data.thresholdReachedAt !== undefined) {
          sets.push('threshold_reached_at = ?')
          values.push(toIso(args.data.thresholdReachedAt))
        }
        values.push(args.where.id, args.where.status)
        const cursor = sql.exec(
          `UPDATE pod_rounds SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
          ...values
        )
        // This is the actual compare-and-swap: 0 means some other caller's
        // WHERE already changed the status first (see fireRound's doc
        // comment in services/pods.ts), 1 means this call won the claim.
        return { count: cursor.rowsWritten }
      },
    },

    podRoundTarget: {
      async findMany(args) {
        const rows = all(sql, 'SELECT * FROM pod_round_targets WHERE pod_round_id = ?', args.where.podRoundId)
        return rows.map(mapPodRoundTargetRow)
      },
      async findUnique(args) {
        const row = maybeOne(
          sql,
          'SELECT * FROM pod_round_targets WHERE pod_round_id = ? AND guild_id = ?',
          args.where.podRoundId_guildId.podRoundId,
          args.where.podRoundId_guildId.guildId
        )
        return row ? mapPodRoundTargetRow(row) : null
      },
      async update(args) {
        const row = one(
          sql,
          'UPDATE pod_round_targets SET message_id = ? WHERE pod_round_id = ? AND guild_id = ? RETURNING *',
          args.data.messageId,
          args.where.podRoundId_guildId.podRoundId,
          args.where.podRoundId_guildId.guildId
        )
        return mapPodRoundTargetRow(row)
      },
    },

    podRoundSignup: {
      async count(args) {
        const row = one<{ n: number }>(
          sql,
          'SELECT COUNT(*) as n FROM pod_round_signups WHERE pod_round_id = ? AND status = ?',
          args.where.podRoundId,
          args.where.status
        )
        return row.n
      },
      async upsert(args) {
        const row = one(
          sql,
          `INSERT INTO pod_round_signups (pod_round_id, discord_id, username_snapshot, source_guild_id, status, signed_up_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (pod_round_id, discord_id) DO UPDATE SET status = ?
           RETURNING *`,
          args.where.podRoundId_discordId.podRoundId,
          args.where.podRoundId_discordId.discordId,
          args.create.usernameSnapshot,
          args.create.sourceGuildId,
          args.create.status,
          toIso(new Date()),
          args.update.status
        )
        return mapPodRoundSignupRow(row)
      },
      async findMany(args) {
        const rows = all(
          sql,
          'SELECT * FROM pod_round_signups WHERE pod_round_id = ? AND status = ?',
          args.where.podRoundId,
          args.where.status
        )
        return rows.map(mapPodRoundSignupRow)
      },
    },
  }
}
